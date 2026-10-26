const express = require('express');
const router = express.Router();

const {
  getAllCustomers,
  getCustomerDetails,
  getCustomerByPhone
} = require('../controllers/customerController');

const { broadcastMessage, getBroadcastAudiences } = require('../controllers/broadcastController');

const auth = require('../middleware/auth');

console.log('🔍 Customer Controller Functions:');
console.log('  - getAllCustomers:', typeof getAllCustomers);
console.log('  - getCustomerDetails:', typeof getCustomerDetails);
console.log('  - getCustomerByPhone:', typeof getCustomerByPhone);
console.log('  - broadcastMessage:', typeof broadcastMessage);

// Specific routes FIRST
if (typeof getCustomerDetails === 'function') {
  router.get('/:phone/details', auth, getCustomerDetails);
  console.log('✅ Registered: GET /api/customers/:phone/details');
} else {
  console.error('❌ getCustomerDetails is not a function');
}

// Broadcast route
if (typeof broadcastMessage === 'function') {
  router.get('/broadcast/audiences', auth, getBroadcastAudiences);
  router.post('/broadcast', auth, broadcastMessage);
  console.log('✅ Registered: POST /api/customers/broadcast');
} else {
  console.error('❌ broadcastMessage is not a function');
}

// General routes LAST
if (typeof getAllCustomers === 'function') {
  router.get('/', auth, getAllCustomers);
  console.log('✅ Registered: GET /api/customers');
} else {
  console.error('❌ getAllCustomers is not a function');
}

module.exports = router;
