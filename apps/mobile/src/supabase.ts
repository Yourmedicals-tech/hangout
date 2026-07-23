/**
 * supabase.ts — the client, and the decision of which backend to use.
 *
 * If there is no anon key, we fall back to MockRepo. That keeps the property
 * that has been true since day one: `npm start` works with zero credentials.
 * The day the key lands in .env, the same code talks to real Postgres.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MockRepo, SupabaseRepo, type Repo } from "@hangout/shared";

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const isLive = Boolean(URL && ANON);

export const supabase: SupabaseClient | null = isLive
  ? createClient(URL, ANON, {
      auth: {
        // Sessions must survive closing the app, or every user signs in again
        // every morning and stops bothering.
        storage: AsyncStorage,
        persistSession: true,
        autoRefreshToken: true,
        // No deep-link callback: we use 6-digit codes, not magic links. See
        // signInWithEmail below for why.
        detectSessionInUrl: false,
      },
    })
  : null;

export const repo: Repo = supabase ? new SupabaseRepo(supabase as any) : new MockRepo();

/**
 * Send a 6-digit code.
 *
 * Codes, not magic links. A magic link needs a URL scheme, deep-link handling
 * and a working universal-link setup before anyone can log in at all — and it
 * breaks the moment someone opens the email on a different device from the one
 * with the app. A code is six characters they can read off one screen and type
 * into another, and it needs no app config whatsoever.
 *
 * Supabase's default email template sends the LINK. To get the code, change the
 * "Magic Link" template to use {{ .Token }} — see BUILD_LOG.md.
 */
export async function signInWithEmail(email: string): Promise<void> {
  if (!supabase) throw new Error("No backend configured");
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { shouldCreateUser: true },
  });
  if (error) throw new Error(error.message);
}

/** Verify the code. Returns the auth user id, which becomes the profile id. */
export async function verifyCode(email: string, code: string): Promise<string> {
  if (!supabase) throw new Error("No backend configured");
  const { data, error } = await supabase.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: code.trim(),
    type: "email",
  });
  if (error) throw new Error(error.message);
  if (!data.user) throw new Error("No user returned");
  return data.user.id;
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

/** Has this device got a session already? Called once on launch. */
export async function hasSession(): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  return Boolean(data.session);
}
