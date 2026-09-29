const parser = require('./utils/parser');
const txt = `Name : Backrooms.2026.2160p.UHD.BluRay.REMUX.HEVC.HDR10.DoVi.MULTi.Atmos.TrueHD.7.1-SPiDEY.mkv
https://gdflix.dev/file/abc`;
console.log(parser.parseMessageBlock(txt, 123));
