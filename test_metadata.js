const { isMetadataLine } = require('./utils/parser');
const t1 = '#BLURAY #REMUX #2160P #MULTi #HEVC #HDR10';
console.log(isMetadataLine(t1));
