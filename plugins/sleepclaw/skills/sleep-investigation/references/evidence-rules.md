# Evidence rules for Apple Health

- Sleep labels are device estimates. Keep Apple Core as Core; it cannot be split into EEG N1/N2 using these records.
- In-bed, sleep and awake may overlap. Use the computed interval union, not a sum of raw rows. Conflicting stages remain conflict/unknown.
- An export may omit awake intervals before/after detected sleep. Unknown intervals stay unknown. Without reliable in-bed bounds and complete coverage, do not compute sleep efficiency or sleep-onset latency.
- Physiology results summarize observed samples without time weighting. Count, first/last timestamp and largest gap expose sparse sampling; they do not certify continuous sensor coverage. Do not interpolate missing points or fill with zero.
- HRV in these imports is the device's SDNN in milliseconds. Discrete HR values or SDNN samples do not supply beat-to-beat RR intervals. Do not compute RMSSD, frequency-domain HRV or autonomic/stress diagnoses from them.
- HealthKit oxygen percent is stored as a fraction. SleepClaw converts valid 0..1 values to displayed percent. Unsupported units/invalid values are excluded and counted; legitimate extreme values are retained without automatic health labeling.
- Statistics use simple-statistics 7.12.0, linear R type-7 quantiles. Empty groups return null; single samples do not describe a distribution or trend. Never compare different sources or incompatible units as one population.
- One episode is not a personal baseline. Longitudinal experiments, causality, disease screening and clinical thresholds are outside these tools.

Primary references: [Apple sleep analysis](https://developer.apple.com/documentation/healthkit/hkcategoryvaluesleepanalysis), [Apple HRV SDNN](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/heartratevariabilitysdnn), [locked quantile implementation](https://github.com/simple-statistics/simple-statistics/blob/v7.12.0/src/quantile_sorted.js).
