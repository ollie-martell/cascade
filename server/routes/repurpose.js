const express = require('express');
const router = express.Router();
const { repurpose } = require('../controllers/repurposeController');

router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.post('/repurpose', repurpose);

module.exports = router;
