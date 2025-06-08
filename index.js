const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/ens/:address', async (req, res) => {
  const address = req.params.address.toLowerCase();

  try {
    const response = await fetch(`https://api.ens.vision/ens/owner/${address}`, { timeout: 5000 });
    if (!response.ok) {
      return res.json({ ens: null, error: 'ENS.Vision error' });
    }

    const data = await response.json();
    const name = (data?.domains?.length > 0) ? data.domains[0].name : null;
    return res.json({ ens: name });
  } catch (err) {
    console.warn(`ENS Proxy error: ${err}`);
    return res.json({ ens: null, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ENS Proxy running on port ${PORT}`);
});

