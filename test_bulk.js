const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const token = jwt.sign({ id: 'test', username: 'admin' }, process.env.JWT_SECRET || 'xloop_jwt_super_secret_2024_key');

const text = `WEBRip x265 HEVC
10bit EAC3 5.1 MULTI
Atmos - ESub) - NazzY
- [ 3.29 GB ]
https://gdflix.dev/file/C4HaquUZKgib60H`;

axios.post('http://localhost:3000/api/import/bulk', 
  { messages: [{ text }] }, 
  { headers: { Authorization: `Bearer ${token}` } }
).then(res => console.log(res.data))
 .catch(err => console.error(err.response?.data || err.message));
