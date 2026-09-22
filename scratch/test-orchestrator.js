require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { role: 'admin' }; next(); });
app.use('/api/import', require('../routes/import.js'));

const server = app.listen(0, async () => {
  const port = server.address().port;
  try {
    const res = await axios.post(`http://localhost:${port}/api/import/fetch-meta`, {
      title: 'Eeswar',
      year: '2002',
      isSeries: false
    });
    console.log('Result for Eeswar 2002:');
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error(err.response?.data || err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});
