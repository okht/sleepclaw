module.exports = {
  module: { rules: [
    { test: /\.tsx?$/, exclude: /node_modules/, use: { loader: 'ts-loader', options: { transpileOnly: true, compilerOptions: { noEmit: false } } } },
    { test: /\.css$/, use: ['style-loader', 'css-loader'] },
    { test: /\.(svg|png|woff2)$/, type: 'asset/resource' }
  ] },
  resolve: { extensions: ['.js', '.ts', '.tsx'] },
};
