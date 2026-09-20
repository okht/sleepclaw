import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import sax from 'sax';
import * as yauzl from 'yauzl';
import type { HealthRecord, ImportSummary } from '../shared/types.js';

export interface ImportOptions {
  signal?: AbortSignal;
  onProgress?: (count: number) => void;
  /** Synchronous sink. The caller owns its transaction and must roll it back on error. */
  onRecord?: (record: HealthRecord) => void;
  limits?: Partial<{ maxXmlBytes: number; maxRecords: number; maxZipEntries: number; maxCompressionRatio: number }>;
}

const DEFAULT_LIMITS = { maxXmlBytes: 2 * 1024 ** 3, maxRecords: 1_000_000, maxZipEntries: 20_000, maxCompressionRatio: 1000 };
const TYPES: Record<string, HealthRecord['type']> = {
  HKCategoryTypeIdentifierSleepAnalysis: 'sleep',
  HKQuantityTypeIdentifierHeartRate: 'heartRate',
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: 'hrv',
  HKQuantityTypeIdentifierRespiratoryRate: 'respiratoryRate',
  HKQuantityTypeIdentifierOxygenSaturation: 'oxygenSaturation',
};
const STAGES: Record<string, string> = {
  HKCategoryValueSleepAnalysisInBed: 'inBed',
  HKCategoryValueSleepAnalysisAwake: 'awake',
  HKCategoryValueSleepAnalysisAsleep: 'unspecified',
  HKCategoryValueSleepAnalysisAsleepUnspecified: 'unspecified',
  HKCategoryValueSleepAnalysisAsleepCore: 'core',
  HKCategoryValueSleepAnalysisAsleepDeep: 'deep',
  HKCategoryValueSleepAnalysisAsleepREM: 'rem',
  '0': 'inBed', '1': 'unspecified', '2': 'awake', '3': 'core', '4': 'deep', '5': 'rem',
};

export function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('导入已取消。', 'AbortError');
}

/** Apple exports include an explicit UTC offset. Preserve it rather than using the PC timezone. */
function timestamp(value: string): { iso: string; offset: string; ms: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!match) throw new Error('记录时间缺少有效日期或明确时区。');
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const offset = zone === 'Z' ? '+00:00' : `${zone.slice(0, 3)}:${zone.replace(':', '').slice(3)}`;
  const offsetHours = Number(offset.slice(1, 3));
  const offsetMinutes = Number(offset.slice(4));
  if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) throw new Error('记录时区偏移无效。');
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction ?? '').padEnd(3, '0')}`;
  const iso = `${local}${offset}`;
  const ms = Date.parse(iso);
  const shift = (offsetHours * 60 + offsetMinutes) * 60_000 * (offset[0] === '-' ? -1 : 1);
  if (!Number.isFinite(ms) || new Date(ms + shift).toISOString().slice(0, -1) !== local) throw new Error('记录包含无效日期或时间。');
  return { iso, offset, ms };
}

function parseRecord(attributes: Record<string, string>): HealthRecord | undefined {
  const type = TYPES[attributes.type];
  if (!type) return undefined;
  const start = timestamp(attributes.startDate ?? '');
  const end = timestamp(attributes.endDate ?? '');
  if (end.ms < start.ms || (type === 'sleep' && end.ms === start.ms)) throw new Error('记录结束时间必须晚于开始时间。');
  let value: string | number;
  if (type === 'sleep') {
    value = STAGES[attributes.value];
    if (!value) throw new Error('睡眠记录包含未知阶段，无法安全解释。');
  } else {
    if (!attributes.value?.trim()) throw new Error('生理记录缺少数值。');
    value = Number(attributes.value);
    if (!Number.isFinite(value) || value < 0) throw new Error('生理记录包含无效数值。');
  }
  const source = attributes.sourceName?.trim() || '未知来源';
  const unit = attributes.unit || undefined;
  // Equivalent timestamp spellings are deduplicated, while original offsets remain available.
  const id = createHash('sha256').update(JSON.stringify([type, source, start.ms, end.ms, value, unit ?? ''])).digest('hex');
  return { id, type, value, unit, source, start: start.iso, end: end.iso, startOffset: start.offset, endOffset: end.offset };
}

async function zipXml(path: string, options: ImportOptions, limits: typeof DEFAULT_LIMITS): Promise<{ stream: Readable; close: () => void; expectedCrc: number }> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value!));
  });
  try {
    const entry = await new Promise<yauzl.Entry>((resolve, reject) => {
      let found: yauzl.Entry | undefined;
      let count = 0;
      const onAbort = () => reject(new DOMException('导入已取消。', 'AbortError'));
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      zip.on('error', (error) => { cleanup(); reject(error); });
      zip.on('end', () => { cleanup(); found ? resolve(found) : reject(new Error('ZIP 中没有找到 export.xml。')); });
      zip.on('entry', (item: yauzl.Entry) => {
        try {
          abortIfRequested(options.signal);
          if (++count > limits.maxZipEntries) throw new Error('ZIP 条目过多，已停止导入。');
          if (item.fileName.split('/').at(-1) === 'export.xml') {
            if (found) throw new Error('ZIP 中存在多个 export.xml，请直接选择需要导入的 XML。');
            if (item.generalPurposeBitFlag & 1) throw new Error('暂不支持加密 ZIP。');
            if (item.uncompressedSize > limits.maxXmlBytes) throw new Error('XML 超过本次导入大小上限。');
            if (item.uncompressedSize / Math.max(item.compressedSize, 1) > limits.maxCompressionRatio) throw new Error('ZIP 压缩比例异常，已停止导入。');
            found = item;
          }
          zip.readEntry();
        } catch (error) { cleanup(); reject(error); }
      });
      try { abortIfRequested(options.signal); zip.readEntry(); } catch (error) { cleanup(); reject(error); }
    });
    abortIfRequested(options.signal);
    const stream = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value!)));
    return { stream, close: () => zip.close(), expectedCrc: entry.crc32 };
  } catch (error) { zip.close(); throw error; }
}

export async function importAppleHealth(path: string, options: ImportOptions = {}): Promise<{ records: HealthRecord[]; summary: ImportSummary }> {
  abortIfRequested(options.signal);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const value of Object.values(limits)) if (!Number.isFinite(value) || value <= 0) throw new Error('导入资源限制必须为正数。');
  const file = await stat(path);
  if (!file.isFile()) throw new Error('请选择 Apple Health XML 或 ZIP 文件。');
  const extension = extname(path).toLowerCase();
  if (!['.xml', '.zip'].includes(extension)) throw new Error('支持的文件格式为 .xml 和 .zip。');
  if (file.size > limits.maxXmlBytes) throw new Error('文件超过本次导入大小上限。');
  let stream: Readable;
  let close: () => void;
  let expectedCrc: number | undefined;
  let checksum = 0;
  if (extension === '.zip') ({ stream, close, expectedCrc } = await zipXml(path, options, limits));
  else { stream = createReadStream(path, { highWaterMark: 64 * 1024 }); close = () => stream.destroy(); }
  const onAbort = () => stream.destroy(new DOMException('导入已取消。', 'AbortError'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const records: HealthRecord[] = [];
  const seen = new Set<string>();
  const sources = new Set<string>();
  const warnings = new Set<string>();
  const hash = createHash('sha256');
  let duplicates = 0;
  let bytes = 0;
  let start: string | undefined;
  let end: string | undefined;
  let root = false;
  let depth = 0;
  // sax supports strictEntities; the community type package does not yet declare it.
  const parserOptions: sax.SAXOptions & { strictEntities: boolean } = { strictEntities: true };
  const parser = sax.parser(true, parserOptions);
  parser.onerror = (error) => { throw new Error(`XML 格式无效：${error.message.split('\n')[0]}`); };
  parser.ondoctype = (declaration) => {
    // Apple exports contain a local element/attribute DTD. Never resolve external identifiers or entities.
    if (/\b(?:SYSTEM|PUBLIC|ENTITY)\b/i.test(declaration)) throw new Error('不接受包含外部资源或自定义实体的 XML。');
  };
  parser.onopentag = (node) => {
    if (++depth > 32) throw new Error('XML 嵌套过深，已停止导入。');
    if (depth === 1) {
      if (node.name !== 'HealthData') throw new Error('这份 XML 不是 Apple Health 导出文件。');
      root = true;
    }
    if (node.name !== 'Record' || depth !== 2) return;
    abortIfRequested(options.signal);
    const record = parseRecord(node.attributes as Record<string, string>);
    if (!record) return;
    if (seen.has(record.id)) { duplicates++; return; }
    if (seen.size >= limits.maxRecords) throw new Error('相关记录数量超过本次导入上限。');
    seen.add(record.id);
    sources.add(record.source);
    if (record.source === '未知来源') warnings.add('部分记录缺少设备来源，分析时需要确认来源。');
    if (!start || Date.parse(record.start) < Date.parse(start)) start = record.start;
    if (!end || Date.parse(record.end) > Date.parse(end)) end = record.end;
    if (options.onRecord) options.onRecord(record);
    else records.push(record);
    if (seen.size % 1000 === 0) options.onProgress?.(seen.size);
  };
  parser.onclosetag = () => { depth--; };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    abortIfRequested(options.signal);
    for await (const chunk of stream) {
      abortIfRequested(options.signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limits.maxXmlBytes) throw new Error('解压后的 XML 超过本次导入大小上限。');
      hash.update(buffer);
      if (expectedCrc !== undefined) checksum = crc32(buffer, checksum);
      parser.write(decoder.decode(buffer, { stream: true }));
    }
    parser.write(decoder.decode()).close();
    if (expectedCrc !== undefined && checksum !== expectedCrc) throw new Error('ZIP 数据校验失败，文件可能已损坏。');
    if (!root) throw new Error('文件没有有效的 Apple Health 数据。');
    abortIfRequested(options.signal);
    if (!seen.size) warnings.add('文件中没有找到可用的睡眠或相关生理记录。');
    options.onProgress?.(seen.size);
    return { records, summary: { id: hash.digest('hex'), name: basename(path), importedAt: new Date().toISOString(), recordCount: seen.size, duplicateCount: duplicates, sources: [...sources].sort(), start, end, warnings: [...warnings] } };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    stream.destroy();
    close();
  }
}
