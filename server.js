require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const app = express();
const port = process.env.PORT || 3000;

// Validate environment variables
const requiredEnvVars = ['DATABASE_URL', 'REDIS_URL'];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Error: Missing required environment variable ${varName}`);
    process.exit(1);
  }
});

console.log('PORT:', process.env.PORT);
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✅ Set' : '❌ Missing');
console.log('REDIS_URL:', process.env.REDIS_URL ? '✅ Set' : '❌ Missing');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client:', err.stack);
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Database connection failed:', err.stack);
    return;
  }
  console.log('✅ Database connection successful');
  release();
});

// Redis connection
const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
});
redisClient.on('error', (err) => console.error('Redis error:', err.message));
redisClient.on('connect', () => console.log('Redis connected'));
redisClient.on('ready', () => console.log('✅ Redis ready'));
redisClient.on('end', () => console.log('Redis connection ended'));

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('Redis connection failed:', err.message);
  }
})();

app.use(express.json());

// Generate unique referral code starting with BGSHWR
const generateReferralCode = async () => {
  let code;
  let exists;
  do {
    const randomNumber = Math.floor(100000 + Math.random() * 900000);
    code = `BGSHWR${randomNumber}`;
    const result = await pool.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    exists = result.rows.length > 0;
  } while (exists);
  return code;
};

// 🔥 1. DYNAMIC PRICING - App fetches live price (CHANGE anytime!)
app.get('/api/pricing', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT price_rupees, duration_days, plan_name 
      FROM premium_plans WHERE is_active = TRUE LIMIT 1
    `);
    res.json({
      success: true,
      current_price: result.rows[0]?.price_rupees || 49,
      duration_days: result.rows[0]?.duration_days || 30,
      plan_name: result.rows[0]?.plan_name || 'Premium'
    });
  } catch (error) {
    res.status(500).json({ error: 'Pricing fetch failed' });
  }
});

// 🔥 2. GENERATE UPI LINK - Unique per device (Your manual verification)
app.post('/api/generate-upi-link', async (req, res) => {
  const { device_id, user_name } = req.body;
  if (!device_id || !user_name) return res.status(400).json({ error: 'Missing data' });
  
  const priceResult = await pool.query('SELECT price_rupees FROM premium_plans WHERE is_active = TRUE LIMIT 1');
  const amount = priceResult.rows[0]?.price_rupees || 49;
  const payment_id = `PAY_${device_id.slice(-8)}_${Date.now()}`;
  const upi_id = 'yourbusiness@paytm'; // ❌ CHANGE THIS TO YOUR UPI!
  
  const upi_link = `upi://pay?pa=${upi_id}&pn=${encodeURIComponent(user_name)}&am=${amount}&cu=INR&tn=${payment_id}`;
  const copy_text = `${amount} ${upi_id} ${payment_id}`;

  await redisClient.setEx(`payment:${payment_id}`, 86400, JSON.stringify({
    device_id, user_name, amount, status: 'pending'
  }));

  res.json({
    success: true,
    payment_id, device_id, user_name, amount,
    upi_link, copy_text, qr_data: upi_link,
    instructions: `Send ₹${amount} & share screenshot`
  });
});

// 🔥 3. SESSION START
app.post('/api/session/start', async (req, res) => {
  const { device_id, session_id } = req.body;
  if (!device_id || !session_id) return res.status(400).json({ error: 'Missing data' });
  await redisClient.setEx(`session:${session_id}`, 3600, JSON.stringify({ device_id, start_time: Date.now() }));
  res.json({ success: true });
});

// 🔥 4. SESSION END
app.post('/api/session/end', async (req, res) => {
  const { device_id, session_id, session_duration } = req.body;
  if (!device_id || !session_id || !session_duration) return res.status(400).json({ error: 'Missing data' });
  
  try {
    await pool.query(`
      UPDATE users SET 
        app_opens = COALESCE(app_opens, 0) + 1,
        total_session_duration = COALESCE(total_session_duration, 0) + $1,
        last_active = NOW(),
        avg_session_duration = CASE 
          WHEN COALESCE(app_opens, 0) = 0 THEN $1 
          ELSE (COALESCE(total_session_duration, 0) + $1)::numeric / (COALESCE(app_opens, 0) + 1)
        END::integer
      WHERE device_id = $2
    `, [session_duration, device_id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Session failed' });
  }
});

// 🔥 5. CHECK USER BY DEVICE - FULL PREMIUM STATUS
app.get('/api/user/device/:device_id', async (req, res) => {
  const { device_id } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        id, device_id, phone, name, coins, referral_code, has_reviewed, share_count, created_at,
        app_opens, total_session_duration, avg_session_duration, last_active,
        is_premium, premium_purchased_at, premium_expires_at,
        CASE WHEN is_premium IS TRUE AND premium_expires_at > NOW() THEN TRUE ELSE FALSE END as premium_active,
        CASE 
          WHEN is_premium IS TRUE AND premium_expires_at > NOW() THEN 
            EXTRACT(days FROM (premium_expires_at - NOW()))::integer 
          ELSE 0 
        END as days_remaining
      FROM users WHERE device_id = $1
    `, [device_id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = result.rows[0];
    await redisClient.setEx(`user_device:${device_id}`, 3600, JSON.stringify(userData));
    console.log(`✅ User: ${device_id} (${userData.premium_active ? 'PREMIUM' : 'FREE'})`);
    res.json(userData);
  } catch (error) {
    console.error('Device lookup error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 🔥 6. PROFILE CREATE/UPDATE
app.post('/api/profile', async (req, res) => {
  const { name, phone, device_id, created_at } = req.body;

  if (!name?.trim() || !phone || phone.length !== 10 || !/^\d{10}$/.test(phone) || !device_id) {
    return res.status(400).json({ error: 'Invalid profile data' });
  }

  try {
    const existingDevice = await pool.query(
      'SELECT id, phone, name, coins, referral_code FROM users WHERE device_id = $1', 
      [device_id]
    );

    if (existingDevice.rows.length > 0) {
      await pool.query(
        'UPDATE users SET phone = $1, name = $2, last_active = NOW() WHERE device_id = $3',
        [phone, name.trim(), device_id]
      );
      
      const updatedUser = { ...existingDevice.rows[0], phone, name: name.trim() };
      await redisClient.del(`user_device:${device_id}`);
      await redisClient.setEx(`user_device:${device_id}`, 3600, JSON.stringify(updatedUser));
      
      console.log(`✅ Updated profile: ${device_id}`);
      res.json({ success: true, ...updatedUser });
      return;
    }

    const referralCode = await generateReferralCode();
    const result = await pool.query(`
      INSERT INTO users (
        device_id, phone, name, coins, referral_code, created_at,
        app_opens, total_session_duration, is_premium, last_active
      ) VALUES ($1, $2, $3, 5, $4, $5, 0, 0, FALSE, NOW())
      RETURNING id, device_id, phone, name, coins, referral_code, created_at
    `, [device_id, phone, name.trim(), referralCode, created_at || new Date()]);

    await redisClient.setEx(`user_device:${device_id}`, 3600, JSON.stringify(result.rows[0]));
    console.log(`✅ New user: ${phone}`);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Profile failed' });
  }
});

// 🔥 7. YOUR MANUAL PREMIUM ACTIVATION
app.post('/api/admin/activate-premium', async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'Missing device_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const planResult = await pool.query('SELECT duration_days FROM premium_plans WHERE is_active = TRUE LIMIT 1');
    const duration_days = planResult.rows[0]?.duration_days || 30;
    
    const result = await client.query(`
      UPDATE users SET 
        is_premium = TRUE,
        premium_purchased_at = NOW(),
        premium_expires_at = NOW() + INTERVAL '${duration_days} days'
      WHERE device_id = $1
      RETURNING id, device_id, phone, name, premium_expires_at
    `, [device_id]);
    
    await client.query('COMMIT');
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    console.log(`✅ MANUAL PREMIUM: ${device_id} → ${result.rows[0].phone}`);
    res.json({ 
      success: true, 
      message: `Activated until ${result.rows[0].premium_expires_at}`,
      user: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Activation failed' });
  } finally {
    client.release();
  }
});

// 🔥 8. CHANGE PRICE (No app update needed!)
app.post('/api/admin/update-price', async (req, res) => {
  const { price_rupees = 49, duration_days = 30 } = req.body;
  await pool.query(`
    UPDATE premium_plans SET 
      price_rupees = $1, duration_days = $2, updated_at = NOW()
    WHERE id = 1
  `, [price_rupees, duration_days]);
  console.log(`💰 Price: ₹${price_rupees} for ${duration_days} days`);
  res.json({ success: true, new_price: price_rupees });
});

// 🔥 YOUR EXISTING ENDPOINTS (UNCHANGED)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/videos', async (req, res) => {
  const { section, limit = 10, offset = 0 } = req.query;
  const parsedLimit = Math.max(1, Math.min(100, parseInt(limit)));
  const parsedOffset = Math.max(0, parseInt(offset));
  const cacheKey = section ? `videos:${section}:${parsedLimit}:${parsedOffset}` : `videos:all:${parsedLimit}:${parsedOffset}`;

  try {
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      console.log(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cachedData));
    }

    let query = section
      ? { text: 'SELECT * FROM videos WHERE section = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', values: [section, parsedLimit, parsedOffset] }
      : { text: 'SELECT * FROM videos ORDER BY created_at DESC LIMIT $1 OFFSET $2', values: [parsedLimit, parsedOffset] };
    
    const result = await pool.query(query);
    await redisClient.setEx(cacheKey, 3600, JSON.stringify(result.rows));
    res.json(result.rows);
  } catch (err) {
    console.error('Videos error:', err);
    res.status(500).send('Server Error');
  }
});

app.post('/api/register-device', async (req, res) => {
  // YOUR EXISTING CODE - UNCHANGED
  const { device_id, referral_code } = req.body;
  if (!device_id) return res.status(400).json({ error: 'Missing device_id' });

  try {
    const existingUserResult = await pool.query('SELECT id, coins, referral_code, has_reviewed, share_count FROM users WHERE device_id = $1', [device_id]);
    if (existingUserResult.rows.length) {
      const user = existingUserResult.rows[0];
      const userData = {
        id: user.id, device_id, coins: user.coins, referral_code: user.referral_code,
        referral_url: `bageshwardham://refer?ref=${user.referral_code}`,
        has_reviewed: user.has_reviewed, share_count: user.share_count,
      };
      await redisClient.setEx(`user:${user.id}`, 3600, JSON.stringify(userData));
      return res.json(userData);
    }

    let coins = 0, referredBy = null;
    if (referral_code) {
      const referrerResult = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referral_code]);
      if (referrerResult.rows.length) {
        referredBy = referral_code;
        coins += 10;
        await pool.query('UPDATE users SET coins = coins + 10 WHERE referral_code = $1', [referral_code]);
      }
    }

    const newReferralCode = await generateReferralCode();
    const result = await pool.query(`
      INSERT INTO users (device_id, coins, referral_code, referred_by, has_reviewed, share_count, is_premium)
      VALUES ($1, $2, $3, $4, $5, $6, FALSE)
      RETURNING id, device_id, coins, referral_code, has_reviewed, share_count
    `, [device_id, coins, newReferralCode, referredBy, false, 0]);

    const userData = {
      id: result.rows[0].id, device_id, coins: result.rows[0].coins,
      referral_code: result.rows[0].referral_code,
      referral_url: `bageshwardham://refer?ref=${result.rows[0].referral_code}`,
      has_reviewed: result.rows[0].has_reviewed, share_count: result.rows[0].share_count,
    };
    await redisClient.setEx(`user:${result.rows[0].id}`, 3600, JSON.stringify(userData));
    res.status(201).json(userData);
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.get('/api/user/:id', async (req, res) => {
  // YOUR EXISTING CODE - ENHANCED WITH PREMIUM
  const { id } = req.params;
  const cacheKey = `user:${id}`;
  try {
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) return res.json(JSON.parse(cachedData));

    const result = await pool.query(`
      SELECT id, device_id, coins, referral_code, has_reviewed, share_count, phone, name,
             is_premium, premium_expires_at, CASE WHEN is_premium AND premium_expires_at > NOW() THEN TRUE ELSE FALSE END as premium_active
      FROM users WHERE id = $1
    `, [id]);

    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    
    const userData = {
      id: result.rows[0].id, device_id: result.rows[0].device_id, phone: result.rows[0].phone,
      name: result.rows[0].name, coins: result.rows[0].coins, referral_code: result.rows[0].referral_code,
      referral_url: `bageshwardham://refer?ref=${result.rows[0].referral_code}`,
      has_reviewed: result.rows[0].has_reviewed, share_count: result.rows[0].share_count,
      is_premium: result.rows[0].is_premium, premium_active: result.rows[0].premium_active
    };
    await redisClient.setEx(cacheKey, 3600, JSON.stringify(userData));
    res.json(userData);
  } catch (error) {
    res.status(500).json({ error: 'User fetch failed' });
  }
});

app.post('/api/submit-review', async (req, res) => {
  // YOUR EXISTING CODE - UNCHANGED
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  
  try {
    const userResult = await pool.query('SELECT coins, has_reviewed FROM users WHERE id = $1', [user_id]);
    if (!userResult.rows.length || userResult.rows[0].has_reviewed) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    
    await pool.query(`
      UPDATE users SET coins = coins + 50, has_reviewed = TRUE WHERE id = $1
      RETURNING id, device_id, coins, referral_code, has_reviewed, share_count, phone, name
    `, [user_id]);
    
    await redisClient.del(`user:${user_id}`);
    res.json({ success: true, message: '50 coins awarded!' });
  } catch (error) {
    res.status(500).json({ error: 'Review failed' });
  }
});

app.post('/api/share-app', async (req, res) => {
  // YOUR EXISTING CODE - SIMPLIFIED
  const { user_id, share_id } = req.body;
  if (!user_id || !share_id) return res.status(400).json({ error: 'Missing data' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO shares (user_id, share_id) VALUES ($1, $2)', [user_id, share_id]);
    await client.query('UPDATE users SET coins = coins + 10, share_count = share_count + 1 WHERE id = $1', [user_id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Share failed' });
  } finally {
    client.release();
  }
});

// 🔥 GLOBAL ERROR HANDLER (LAST)
app.use((err, req, res, next) => {
  console.error('🚨 ERROR:', err.stack);
  res.status(500).json({ success: false, error: 'Server error' });
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`✅ ALL ENDPOINTS READY: Premium + Videos + Referrals + Analytics`);
});
