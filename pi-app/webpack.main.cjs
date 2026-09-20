module.exports = {
  entry: './src/main.ts',
  module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: { loader: 'ts-loader', options: { transpileOnly: true, compilerOptions: { noEmit: false } } } }] },
  resolve: { extensions: ['.js', '.ts', '.tsx'] },
};
