const parser = require('./utils/parser');
const txt = `🍿 #BLURAY #REMUX #2160P #MULTi #HEVC #HDR10

Toy.Story.5.2026.2160p.UHD.BluRay.REMUX.HEVC.HDR10.DoVi.MULTi.TrueHD.Atmos.7.1-SPiDEYxFLASH.mkv [48.21 GB]
https://gdflix.dev/file/Tpr5FP6Du9371w1`;
console.log(parser.parseMessageBlock(txt, 1926));
