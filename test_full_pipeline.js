require('dotenv').config();
const { searchTMDB } = require('./pipeline_full');
const parser = require('./utils/parser');

async function test(txt) {
  const parsed = parser.parseMessageBlock(txt, 100);
  console.log("Parsed:", parsed);
  if (!parsed) return;
  const tmdb = await searchTMDB(parsed.title, parsed.year, parsed.isSeries, parsed.season, null, null, null);
  console.log("TMDB:", tmdb);
}

test(`Name : Backrooms.2026.2160p.UHD.BluRay.REMUX.HEVC.HDR10.DoVi.MULTi.Atmos.TrueHD.7.1-SPiDEY.mkv
https://gdflix.dev/file/abc`).then(() => {
  test(`Name : Enola.Holmes.3.2026.2160p.SDR.NF.WEB-DL.MULTI.DDP5.1.Atmos.H.265-END.mkv
https://gdflix.dev/file/def`);
});
