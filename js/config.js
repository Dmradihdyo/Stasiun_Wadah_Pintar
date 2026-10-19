// Isi dari Supabase Dashboard > Project Settings > API.
// Anon key aman dipublikasikan: akses data dibatasi oleh RLS. JANGAN pernah menaruh service_role key di sini.
export const SUPABASE_URL = 'https://rdrzrxambxgqjbazuopo.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Ya-q4xr6ZeOeRggcPuqasQ_LzD3Mj3e';

// Pemeriksaan di browser hanya untuk pesan yang ramah. Penegakan sebenarnya ada di database
// (kolom allowed_domains di tabel app_config, bisa diubah di panel Admin > Pengaturan).
export const ALLOWED_DOMAINS = ['trisakti.ac.id', 'std.trisakti.ac.id'];
