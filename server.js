const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// simple proxy endpoint to fetch external pages (to avoid CORS in browser)
// USAGE: /proxy?url=https://www.apex-timing.com/live-timing/...
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('missing url');
  try {
    const response = await fetch(url, { timeout: 10000 });
    const text = await response.text();
    res.set('Content-Type', 'text/html');
    res.send(text);
  } catch (err) {
    console.error('proxy err', err.message);
    res.status(500).send('fetch error');
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
