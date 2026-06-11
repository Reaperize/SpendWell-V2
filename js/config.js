// SpendWell configuration.
//
// Fill these in with the values from your Supabase project
// (Dashboard -> Project Settings -> API). Both values are PUBLIC by design:
// the anon key is meant to ship to browsers and is safe to commit — access to
// data is enforced server-side by Row Level Security, not by hiding this key.
//
// NEVER put the Supabase service_role key (or any other secret) in this file
// or anywhere else in frontend code.
//
// Leave both values empty to run in local-only mode (data is encrypted with a
// passphrase and stored in this browser only — no accounts, no cross-device sync).
window.SPENDWELL_CONFIG = {
  SUPABASE_URL: "https://ycqzyrjseebzlahojzsr.supabase.co",      // project URL only — no /rest/v1/ suffix
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljcXp5cmpzZWViemxhaG9qenNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTkzMDgsImV4cCI6MjA5NjczNTMwOH0.ouDUK-VZNhSwKG7GrbkRyeUKxZP0FeDe860UwARLUXk"  // the "anon / public" API key
};
