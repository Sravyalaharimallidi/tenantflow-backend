const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables');
}

// Admin client for server-side operations
const supabase = createClient(supabaseUrl, supabaseKey);

// Public client for client-side operations
const supabasePublic = createClient(supabaseUrl, supabaseAnonKey);

module.exports = {
  supabase,
  supabasePublic
};
