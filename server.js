// Screenhound Backend - Twilio Webhook + API
// This receives SMS/MMS from Twilio and stores submissions

const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// CORS for frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ============================================
// TWILIO WEBHOOK - Receives SMS/MMS
// ============================================
app.post('/webhook/twilio', async (req, res) => {
  try {
    const {
      From: phoneNumber,
      Body: messageBody,
      NumMedia: numMedia,
      MediaUrl0: mediaUrl,
      MediaContentType0: mediaType
    } = req.body;

    console.log('Received message from:', phoneNumber);
    console.log('Body:', messageBody);
    console.log('Media count:', numMedia);

    // Determine submission type
    const hasImage = parseInt(numMedia) > 0;
    const submissionType = hasImage ? 'dog_photo' : 'trivia';

    let submission = {
      phone_number: phoneNumber,
      type: submissionType,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    if (hasImage) {
      // Dog photo submission
      const dogName = messageBody.trim() || 'Anonymous Pup';
      
      submission = {
        ...submission,
        dog_name: dogName,
        image_url: mediaUrl,
        media_type: mediaType,
        owner_name: extractOwnerName(messageBody)
      };

      // Insert into dog_photos table
      const { data, error } = await supabase
        .from('dog_photos')
        .insert([submission]);

      if (error) throw error;

      console.log('Dog photo saved:', data);

    } else {
      // Trivia submission
      submission = {
        ...submission,
        trivia_text: messageBody,
      };

      // Insert into trivia_submissions table
      const { data, error } = await supabase
        .from('trivia_submissions')
        .insert([submission]);

      if (error) throw error;

      console.log('Trivia saved:', data);
    }

    // Respond to Twilio (sends auto-reply to user)
    res.type('text/xml');
    res.send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Message>Thanks for submitting to Screenhound! 🐕 Your ${hasImage ? 'photo' : 'dog fact'} will appear on screen once approved!</Message>
      </Response>
    `);

  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error processing submission');
  }
});

// ============================================
// API ENDPOINTS
// ============================================

// Get approved content for display
app.get('/api/content/:locationId?', async (req, res) => {
  try {
    const locationId = req.params.locationId || 'default';

    // Get approved dog photos
    const { data: photos, error: photoError } = await supabase
      .from('dog_photos')
      .select('*')
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(20);

    if (photoError) throw photoError;

    // Get approved trivia
    const { data: trivia, error: triviaError } = await supabase
      .from('trivia_submissions')
      .select('*')
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(10);

    if (triviaError) throw triviaError;

    // Format for display component
    const content = [
      ...photos.map(p => ({
        type: 'dog',
        name: p.dog_name,
        image: p.image_url,
        owner: p.owner_name || 'A Friend'
      })),
      ...trivia.map(t => ({
        type: 'trivia',
        fact: t.trivia_text
      }))
    ];

    res.json({ content, success: true });

  } catch (error) {
    console.error('Error fetching content:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// Get pending submissions for moderation
app.get('/api/moderation/pending', async (req, res) => {
  try {
    // Get pending photos
    const { data: photos, error: photoError } = await supabase
      .from('dog_photos')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (photoError) throw photoError;

    // Get pending trivia
    const { data: trivia, error: triviaError } = await supabase
      .from('trivia_submissions')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (triviaError) throw triviaError;

    res.json({ 
      photos: photos || [], 
      trivia: trivia || [],
      success: true 
    });

  } catch (error) {
    console.error('Error fetching pending:', error);
    res.status(500).json({ error: 'Failed to fetch pending submissions' });
  }
});

// Approve/Reject submission
app.post('/api/moderation/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { action } = req.body; // 'approve' or 'reject'

    const table = type === 'photo' ? 'dog_photos' : 'trivia_submissions';
    const status = action === 'approve' ? 'approved' : 'rejected';

    const { data, error } = await supabase
      .from(table)
      .update({ status })
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, data });

  } catch (error) {
    console.error('Error moderating submission:', error);
    res.status(500).json({ error: 'Failed to moderate submission' });
  }
});

// Web form submission endpoints
app.post('/api/submit/photo', async (req, res) => {
  try {
    const { phone_number, dog_name, owner_name, image_url, media_type } = req.body;

    const { data, error } = await supabase
      .from('dog_photos')
      .insert([{
        phone_number: phone_number || 'web-submission',
        dog_name: dog_name,
        owner_name: owner_name,
        image_url: image_url,
        media_type: media_type || 'image/jpeg',
        status: 'pending'
      }]);

    if (error) throw error;

    res.json({ success: true, message: 'Photo submitted!' });
  } catch (error) {
    console.error('Error submitting photo:', error);
    res.status(500).json({ error: 'Failed to submit photo' });
  }
});

app.post('/api/submit/trivia', async (req, res) => {
  try {
    const { phone_number, trivia_text } = req.body;

    const { data, error } = await supabase
      .from('trivia_submissions')
      .insert([{
        phone_number: phone_number || 'web-submission',
        trivia_text: trivia_text,
        status: 'pending'
      }]);

    if (error) throw error;

    res.json({ success: true, message: 'Trivia submitted!' });
  } catch (error) {
    console.error('Error submitting trivia:', error);
    res.status(500).json({ error: 'Failed to submit trivia' });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function extractOwnerName(text) {
  // Try to extract owner name from message
  // Patterns like "This is Max - Sarah" or "Max (Sarah)"
  const patterns = [
    /[-–—]\s*([A-Za-z]+)\s*$/,  // "Max - Sarah"
    /\(([A-Za-z]+)\)\s*$/,       // "Max (Sarah)"
    /by\s+([A-Za-z]+)\s*$/i,     // "Max by Sarah"
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'screenhound-api' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Screenhound backend running on port ${PORT}`);
  console.log(`Twilio webhook: http://your-domain.com/webhook/twilio`);
});
app.listen(PORT, () => {
  console.log(`Screenhound backend running on port ${PORT}`);
  console.log(`Twilio webhook: http://your-domain.com/webhook/twilio`);
});
