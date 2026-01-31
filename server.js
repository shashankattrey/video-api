require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const streamifier = require('streamifier');
const { v4: uuidv4 } = require('uuid');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(), // REQUIRED for Render
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files allowed'));
    }
    cb(null, true);
  },
});


// Validate environment variables
const requiredEnvVars = ['DATABASE_URL', 'REDIS_URL'];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Error: Missing required environment variable ${varName}`);
    process.exit(1);
  }
});

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Database error:', err.stack);
});

// Redis connection
const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
  socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 5000) }
});

redisClient.on('error', (err) => console.error('Redis error:', err.message));
redisClient.on('ready', () => console.log('✅ Redis ready'));

app.use(express.json());

// Rate limiting for payment endpoints
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Too many payment requests' },
  keyGenerator: (req) => req.body.device_id
});

// Generate unique referral code
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

// 🔥 1. DYNAMIC PRICING
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

// 🔥 2. GENERATE UPI LINK
app.post('/api/generate-upi-link', paymentLimiter, async (req, res) => {
  let { device_id, user_name } = req.body;  // ✅ FIXED: let (not const)
  
  console.log('📥 UPI Request:', { device_id, user_name });

  // ✅ Validation - accepts your "7cf33578" (8 chars)
  if (!device_id || device_id.length < 6 || device_id.length > 100) {
    return res.status(400).json({ 
      error: 'Invalid device_id length',
      debug: { received: device_id, length: device_id?.length }
    });
  }
  
  // ✅ Clean device ID (remove leading zeros, max 36 chars)
  device_id = device_id.replace(/^0+/, '').slice(0, 36);
  
  if (!user_name) user_name = 'BageshwarDham User';

  try {
    // ✅ Dynamic price from DB
    const priceResult = await pool.query(
      'SELECT price_rupees FROM premium_plans WHERE is_active = TRUE LIMIT 1'
    );
    const amount = priceResult.rows[0]?.price_rupees || 49;
    
    // ✅ Unique payment ID using your device ID
    const payment_id = `PAY_${device_id.slice(-8)}_${Date.now()}`;
    const upi_id = process.env.UPI_ID || '9549800020@pthdfc';
    
    // ✅ PERFECT UPI Deep Link - opens PhonePe/GPay directly
    const upi_link = `upi://pay?pa=${upi_id}&pn=${encodeURIComponent(user_name)}&am=${amount}&cu=INR&tn=${payment_id}`;
    const copy_text = `${amount} ${upi_id} ${payment_id}`;

    // ✅ Cache payment in Redis (24h)
    await redisClient.setEx(
      `payment:${payment_id}`, 
      86400, 
      JSON.stringify({ device_id, user_name, amount, status: 'pending' })
    );

    // ✅ COMPLETE Response - matches your app expectations
    res.json({
      success: true,
      payment_id, 
      device_id, 
      user_name, 
      amount,
      upi_id,
      upi_link,           // ← Your app uses this
      copy_text, 
      qr_data: upi_link,
      instructions: `Send ₹${amount} & share screenshot`
    });

  } catch (error) {
    console.error('💥 UPI Error:', error);
    res.status(500).json({ error: 'Payment link generation failed' });
  }
});

// 🔥 3. SESSION START
// 🔥 FIXED SESSION START - Updates last_active IMMEDIATELY
// 🔥 PERFECT SESSION START - Matches Your Schema EXACTLY
app.post('/api/session/start', async (req, res) => {
  const { device_id, session_id } = req.body;
  
  console.log('📥 SESSION/START:', { 
    device_id: device_id?.slice(-8), 
    session_id: session_id?.slice(0,12) 
  });
  
  if (!device_id || !session_id) {
    return res.status(400).json({ error: 'Missing device_id or session_id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // STEP 1: Create session record
    const sessionResult = await client.query(`
      INSERT INTO user_sessions (device_id, session_id, start_time, session_duration, created_at)
      VALUES ($1, $2, NOW(), 0, NOW())
      RETURNING id, device_id, session_id, start_time
    `, [device_id, session_id]);
    
    // STEP 2: Update users.last_active + analytics (SIMPLE VERSION)
    const userResult = await client.query(`
      UPDATE users 
      SET 
        app_opens = COALESCE(app_opens, 0) + 1,
        last_active = NOW()
      WHERE device_id = $1
      RETURNING device_id, app_opens, last_active
    `, [device_id]);
    
    // STEP 3: Create user if doesn't exist
    if (userResult.rowCount === 0) {
      const newUserResult = await client.query(`
        INSERT INTO users (device_id, coins, referral_code, app_opens, last_active)
        VALUES ($1, 0, 'FREE_' || substr(md5(random()::text), 1, 8), 1, NOW())
        RETURNING device_id, app_opens, last_active
      `, [device_id]);
      console.log('✅ NEW USER CREATED:', newUserResult.rows[0]);
    } else {
      console.log('✅ USER UPDATED:', userResult.rows[0]);
    }
    
    console.log('✅ SESSION CREATED:', sessionResult.rows[0]);
    await client.query('COMMIT');
    
    res.json({ 
      success: true, 
      session_id: sessionResult.rows[0].id,
      user_active: userResult.rowCount > 0 || true
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('💥 SESSION/START ERROR:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// 🔥 4. SESSION END - PERFECTLY MATCHES YOUR SCHEMA
app.post('/api/session/end', async (req, res) => {
  const { device_id, session_id, session_duration } = req.body;
  
  console.log('📥 [SESSION/END] Received:', { 
    device_id: device_id?.slice(-8), 
    session_id: session_id?.slice(0,12),
    duration: session_duration 
  });
  
  // VALIDATION
  if (!device_id || !session_id || session_duration === undefined || session_duration < 0) {
    console.log('❌ [SESSION/END] Invalid data');
    return res.status(400).json({ error: 'Missing/invalid data' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 🔥 STEP 1: FIRST verify session exists for this device
    const sessionCheck = await client.query(`
      SELECT id, session_duration FROM user_sessions 
      WHERE session_id = $1 AND device_id = $2
    `, [session_id, device_id]);
    
    if (sessionCheck.rows.length === 0) {
      console.log('⚠️ [SESSION/END] No session found for device+session_id');
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found' });
    }
    
    console.log('✅ [SESSION/END] Found session:', sessionCheck.rows[0]);

    // 🔥 STEP 2: UPDATE user_sessions table
    const sessionResult = await client.query(`
      UPDATE user_sessions 
      SET 
        session_duration = $1,
        end_time = NOW()
      WHERE session_id = $2 AND device_id = $3
      RETURNING id, device_id, session_duration, end_time
    `, [session_duration, session_id, device_id]);
    
    console.log('✅ [SESSION/END] Session updated:', sessionResult.rows[0]);

    // 🔥 STEP 3: UPDATE users table analytics + last_active
    const userResult = await client.query(`
      UPDATE users 
      SET 
        app_opens = COALESCE(app_opens, 0) + 1,
        total_session_duration = COALESCE(total_session_duration, 0) + $1,
        last_active = NOW(),
        avg_session_duration = CASE 
          WHEN COALESCE(app_opens, 0) = 0 THEN GREATEST(1, $1)
          ELSE GREATEST(1, (COALESCE(total_session_duration, 0) + $1)::numeric / (COALESCE(app_opens, 0) + 1))
        END::integer
      WHERE device_id = $2
      RETURNING id, device_id, app_opens, total_session_duration, last_active, avg_session_duration
    `, [session_duration, device_id]);
    
    console.log('✅ [SESSION/END] User updated:', userResult.rows[0] || 'No user found');

    await client.query('COMMIT');
    
    // Clear Redis cache
    await redisClient.del(`session:${session_id}`);
    await redisClient.del(`user_device:${device_id}`);
    
    res.json({ 
      success: true,
      updated: {
        session: sessionResult.rows[0],
        user: userResult.rows[0]
      }
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('💥 [SESSION/END] ERROR:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Add to your server (after session/end)
app.post('/api/session/auto-close', async (req, res) => {
  console.log('🧹 AUTO-CLOSE running...');
  
  const client = await pool.connect();
  try {
    const result = await client.query(`
      UPDATE user_sessions 
      SET 
        end_time = NOW(),
        session_duration = EXTRACT(EPOCH FROM (NOW() - start_time))::integer
      WHERE end_time IS NULL 
        AND NOW() - start_time > INTERVAL '2 minutes'
        AND device_id IN (
          SELECT device_id FROM users 
          WHERE last_active < NOW() - INTERVAL '5 minutes'
        )
      RETURNING COUNT(*)
    `);
    
    console.log(`🧹 Auto-closed ${result.rows[0].count || 0} sessions`);
    res.json({ success: true, closed: result.rows[0].count || 0 });
  } finally {
    client.release();
  }
});


// 🔥 5. DEBUG SESSIONS
app.get('/api/debug/sessions', async (req, res) => {
  try {
    const count = await pool.query('SELECT COUNT(*) as total FROM user_sessions');
    const recent = await pool.query(`
      SELECT s.*, u.name, u.phone 
      FROM user_sessions s 
      LEFT JOIN users u ON s.device_id = u.device_id 
      ORDER BY s.created_at DESC LIMIT 5
    `);
    
    res.json({
      success: true,
      total_sessions: parseInt(count.rows[0].total),
      recent_sessions: recent.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 6. USER BY DEVICE
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
    res.json(userData);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 🔥 7. PROFILE CREATE/UPDATE
app.post('/api/profile', async (req, res) => {
  const { name, phone, device_id, created_at } = req.body;

  if (!name?.trim() || !phone || phone.length !== 10 || !/^\d{10}$/.test(phone) || !device_id) {
    return res.status(400).json({ error: 'Invalid profile data' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const existingDevice = await client.query(
      'SELECT id, phone, name, coins, referral_code FROM users WHERE device_id = $1', 
      [device_id]
    );

    if (existingDevice.rows.length > 0) {
      await client.query(
        'UPDATE users SET phone = $1, name = $2, last_active = NOW() WHERE device_id = $3',
        [phone, name.trim(), device_id]
      );
      
      const updatedUser = { ...existingDevice.rows[0], phone, name: name.trim() };
      await redisClient.del(`user_device:${device_id}`);
      await redisClient.setEx(`user_device:${device_id}`, 3600, JSON.stringify(updatedUser));
      
      await client.query('COMMIT');
      res.json({ success: true, ...updatedUser });
      return;
    }

    const referralCode = await generateReferralCode();
    const result = await client.query(`
      INSERT INTO users (
        device_id, phone, name, coins, referral_code, created_at,
        app_opens, total_session_duration, is_premium, last_active
      ) VALUES ($1, $2, $3, 5, $4, $5, 0, 0, FALSE, NOW())
      RETURNING id, device_id, phone, name, coins, referral_code, created_at
    `, [device_id, phone, name.trim(), referralCode, created_at || new Date()]);

    await redisClient.setEx(`user_device:${device_id}`, 3600, JSON.stringify(result.rows[0]));
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Profile failed' });
  } finally {
    client.release();
  }
});

// 🔥 8. ADMIN PREMIUM ACTIVATION
app.post('/api/admin/activate-premium', async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'Missing device_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const planResult = await client.query('SELECT duration_days FROM premium_plans WHERE is_active = TRUE LIMIT 1');
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

// 🔥 9. ADMIN UPDATE PRICE
app.post('/api/admin/update-price', async (req, res) => {
  const { price_rupees = 49, duration_days = 30, plan_name = 'Premium' } = req.body;
  
  try {
    await pool.query(`
      INSERT INTO premium_plans (id, price_rupees, duration_days, plan_name, is_active, updated_at)
      VALUES (1, $1, $2, $3, TRUE, NOW())
      ON CONFLICT (id) DO UPDATE SET
        price_rupees = $1, duration_days = $2, plan_name = $3, is_active = TRUE, updated_at = NOW()
    `, [price_rupees, duration_days, plan_name]);
    
    res.json({ success: true, new_price: price_rupees, duration_days });
  } catch (error) {
    res.status(500).json({ error: 'Price update failed' });
  }
});

// 🔥 10. VIDEOS ENDPOINT
app.get('/api/videos', async (req, res) => {
  const { section, limit = 10, offset = 0 } = req.query;
  const parsedLimit = Math.max(1, Math.min(100, parseInt(limit)));
  const parsedOffset = Math.max(0, parseInt(offset));
  const cacheKey = `videos:${section || 'all'}:${parsedLimit}:${parsedOffset}`;

  try {
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

    let query = section
      ? { text: 'SELECT * FROM videos WHERE section = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', values: [section, parsedLimit, parsedOffset] }
      : { text: 'SELECT * FROM videos ORDER BY created_at DESC LIMIT $1 OFFSET $2', values: [parsedLimit, parsedOffset] };
    
    const result = await pool.query(query);
    await redisClient.setEx(cacheKey, 3600, JSON.stringify(result.rows));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Videos fetch failed' });
  }
});

// 🔥 11. REGISTER DEVICE
app.post('/api/register-device', async (req, res) => {
  const { device_id, referral_code } = req.body;
  if (!device_id) return res.status(400).json({ error: 'Missing device_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const existingUserResult = await client.query(
      'SELECT id, coins, referral_code, has_reviewed, share_count FROM users WHERE device_id = $1', 
      [device_id]
    );
    
    if (existingUserResult.rows.length) {
      const user = existingUserResult.rows[0];
      const userData = {
        id: user.id, device_id, coins: user.coins, referral_code: user.referral_code,
        referral_url: `bageshwardham://refer?ref=${user.referral_code}`,
        has_reviewed: user.has_reviewed, share_count: user.share_count,
      };
      await client.query('COMMIT');
      await redisClient.setEx(`user:${user.id}`, 3600, JSON.stringify(userData));
      return res.json(userData);
    }

    let coins = 0, referredBy = null;
    if (referral_code) {
      const referrerResult = await client.query('SELECT id FROM users WHERE referral_code = $1', [referral_code]);
      if (referrerResult.rows.length) {
        referredBy = referral_code;
        coins += 10;
        await client.query('UPDATE users SET coins = coins + 10 WHERE referral_code = $1', [referral_code]);
      }
    }

    const newReferralCode = await generateReferralCode();
    const result = await client.query(`
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
    
    await client.query('COMMIT');
    await redisClient.setEx(`user:${result.rows[0].id}`, 3600, JSON.stringify(userData));
    res.status(201).json(userData);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});




// 🔥 12. USER BY ID
app.get('/api/user/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `user:${id}`;
  
  try {
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) return res.json(JSON.parse(cachedData));

    const result = await pool.query(`
      SELECT id, device_id, coins, referral_code, has_reviewed, share_count, phone, name,
             is_premium, premium_expires_at, 
             CASE WHEN is_premium AND premium_expires_at > NOW() THEN TRUE ELSE FALSE END as premium_active
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

// 🔥 13. SUBMIT REVIEW
app.post('/api/submit-review', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const userResult = await client.query('SELECT coins, has_reviewed FROM users WHERE id = $1', [user_id]);
    if (!userResult.rows.length || userResult.rows[0].has_reviewed) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid request' });
    }
    
    await client.query(`
      UPDATE users SET coins = coins + 50, has_reviewed = TRUE WHERE id = $1
      RETURNING id, device_id, coins, referral_code, has_reviewed, share_count, phone, name
    `, [user_id]);
    
    await client.query('COMMIT');
    await redisClient.del(`user:${user_id}`);
    res.json({ success: true, message: '50 coins awarded!' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Review failed' });
  } finally {
    client.release();
  }
});

// 🔥 14. SHARE APP
app.post('/api/share-app', async (req, res) => {
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
// 🔥 16. TRACK AARTI & LIVE KATHA CLICKS  ← ADD THIS ENTIRE BLOCK
// 🔥 16. TRACK AARTI & LIVE KATHA CLICKS - CLICK TRACKING ONLY
app.post('/api/track-premium-click', async (req, res) => {
  const { device_id, section, timestamp } = req.body;
  
  console.log(`🔥 API HIT: ${section.toUpperCase()} → ${device_id.slice(-8)}`);
  
  if (!device_id || !section) {
    console.log('❌ MISSING DATA');
    return res.status(400).json({ error: 'Missing device_id or section' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const pgTimestamp = new Date(timestamp || Date.now()).toISOString();
    
    // 🔥 1. ALWAYS track clicks in premium_clicks table
    const result = await client.query(`
      INSERT INTO premium_clicks (device_id, section, clicked_at, click_count) 
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (device_id, section) 
      DO UPDATE SET 
        click_count = premium_clicks.click_count + 1,
        last_clicked_at = $3,
        updated_at = NOW()
      RETURNING device_id, section, click_count
    `, [device_id, section, pgTimestamp]);
    
    // 🔥 2. ONLY update users table IF USER ALREADY EXISTS
    const userCheck = await client.query(
      'SELECT id FROM users WHERE device_id = $1', 
      [device_id]
    );
    
    if (userCheck.rows.length > 0) {
      // ✅ EXISTING USER ONLY - Update tracking fields
      await client.query(`
        UPDATE users 
        SET 
          premium_clicks = COALESCE(premium_clicks, 0) + 1,
          last_premium_click = $1,
          last_section_clicked = $2,
          last_active = NOW()
        WHERE device_id = $3
      `, [pgTimestamp, section, device_id]);
      console.log(`🔄 USER ${device_id.slice(-8)}: ${result.rows[0].click_count} clicks`);
    } else {
      // ✅ NO USER? Just track clicks, skip user table
      console.log(`⚠️ NO USER ${device_id.slice(-8)}: Clicks tracked only`);
    }
    
    await client.query('COMMIT');
    res.json({ success: true, section, clicks: result.rows[0].click_count });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('💥 Premium click ERROR:', error.message);
    res.status(500).json({ error: 'Tracking failed' });
  } finally {
    client.release();
  }
});

// 🔥 CHECK PREMIUM STATUS
app.get('/api/premium/status/:device_id', async (req, res) => {
  const { device_id } = req.params;

  if (!device_id) {
    return res.status(400).json({ error: 'Missing device_id' });
  }

  try {
    const result = await pool.query(`
      SELECT 
        is_premium,
        premium_expires_at,
        CASE 
          WHEN is_premium IS TRUE AND premium_expires_at > NOW()
          THEN TRUE 
          ELSE FALSE 
        END AS premium_active,
        CASE 
          WHEN premium_expires_at > NOW()
          THEN EXTRACT(days FROM (premium_expires_at - NOW()))::integer
          ELSE 0
        END AS days_remaining
      FROM users
      WHERE device_id = $1
    `, [device_id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      premium_active: result.rows[0].premium_active,
      expires_at: result.rows[0].premium_expires_at,
      days_remaining: result.rows[0].days_remaining,
    });

  } catch (error) {
    console.error('💥 Premium status error:', error.message);
    res.status(500).json({ error: 'Premium check failed' });
  }
});
// 🔥 VERIFY PAYMENT SCREENSHOT (RENDER + CLOUDINARY)
app.post(
  '/api/verify-screenshot',
  upload.single('screenshot'),
  async (req, res) => {
    try {
      const { device_id, payment_id, amount } = req.body;

      console.log('📥 VERIFY SCREENSHOT:', {
        device: device_id?.slice(-8),
        payment_id,
        amount,
      });

      // ✅ Validation
      if (!device_id || !payment_id || !amount) {
        return res.status(400).json({
          error: 'Missing device_id, payment_id or amount',
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: 'Screenshot file is required',
        });
      }

      // 🔥 Upload to Cloudinary
      const uploadToCloudinary = () =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: 'payment_screenshots',
              public_id: `payment_${payment_id}_${uuidv4()}`,
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );

          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });

      const cloudinaryResult = await uploadToCloudinary();

      // 🔥 Store URL in DB
      const result = await pool.query(
        `
        INSERT INTO payment_verifications (
          device_id,
          payment_id,
          amount,
          screenshot_url,
          status,
          created_at
        )
        VALUES ($1, $2, $3, $4, 'pending', NOW())
        RETURNING id, screenshot_url, status
        `,
        [
          device_id,
          payment_id,
          amount,
          cloudinaryResult.secure_url,
        ]
      );

      console.log('✅ Screenshot stored:', result.rows[0]);

      res.json({
        success: true,
        message: 'Screenshot uploaded successfully',
        data: result.rows[0],
      });
    } catch (error) {
      console.error('💥 VERIFY SCREENSHOT ERROR:', error.message);
      res.status(500).json({ error: 'Screenshot upload failed' });
    }
  }
);






// 🔥 HEALTH CHECK
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  await redisClient.quit();
  process.exit(0);
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('ERROR:', err.stack);
  res.status(500).json({ success: false, error: 'Server error' });
});

(async () => {
  await redisClient.connect();
  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log('✅ All APIs ready: Premium + Sessions + Analytics + Referrals');
  });
})();
