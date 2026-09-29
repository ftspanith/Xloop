const parser = require('./utils/parser');
const txt = `💥 #BLURAY #MULTI_AUDIO

Spider-Man 2 2004 2160p UHD BluRay 10bit HDR x265 Multi Audio [Tamil (DTS 5.1 - 1.5Mbps) + Telugu + Hindi + English(Atmos)] DD 5.1 (640Kbps) ESub.mkv
https://gdflix.dev/file/4tsSvxbGvBO69aA`;
console.log(parser.parseMessageBlock(txt, 2090));
