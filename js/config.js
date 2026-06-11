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
  SUPABASE_URL: "",      // e.g. "https://abcdefghijkl.supabase.co"
  SUPABASE_ANON_KEY: ""  // the "anon / public" API key
};
