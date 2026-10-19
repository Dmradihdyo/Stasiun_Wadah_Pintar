import {createClient} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import {SUPABASE_URL, SUPABASE_ANON_KEY} from './config.js';

export const configured = !SUPABASE_URL.includes('ISI_DI_SINI') && !SUPABASE_ANON_KEY.includes('ISI_DI_SINI');
export const sb = createClient(configured ? SUPABASE_URL : 'https://invalid.supabase.co', configured ? SUPABASE_ANON_KEY : 'invalid', {
  auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce'},
  realtime: {params: {eventsPerSecond: 10}}
});
// Melempar error Supabase agar mudah ditangkap dengan try/catch.
export const ok = async p => { const {data, error} = await p; if (error) throw error; return data; };
export {SUPABASE_URL, SUPABASE_ANON_KEY};
