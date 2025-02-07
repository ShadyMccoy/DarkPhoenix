const path = require('path');

module.exports = {
    entry: './src/main.ts',
    devtool: 'source-map', // Generates source maps
    output: {
        filename: 'main.js',
        path: path.resolve(__dirname, 'dist'),
        libraryTarget: 'commonjs',
        sourceMapFilename: 'main.js.map.js', // Outputs source maps normally
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    target: 'node',
    mode: 'development', // Switch to 'production' for final builds
};
