// Account rules shared by the local backend and the live (Supabase) one.

/** 01XXXXXXXXX for any common way of writing a Bangladeshi mobile number, else null. */
export function normalizePhone(input: unknown): string | null {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.startsWith('880')) d = d.slice(2);
  if (/^1\d{9}$/.test(d)) d = `0${d}`;
  return /^01[3-9]\d{8}$/.test(d) ? d : null;
}

export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use a password of at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

/** A student ID as stored (no spaces, dashes or slashes; upper case), or null. Mirrors normalize_student_id() in SQL. */
export function normalizeStudentId(input: unknown): string | null {
  const v = String(input ?? '').replace(/[\s/-]/g, '').toUpperCase();
  return /^[A-Z0-9]{3,24}$/.test(v) ? v : null;
}

/** What a sign-in identifier is: a coupon number (up to 4 digits), a staff phone number, or a student ID. */
export function identifierKind(input: unknown): 'coupon' | 'phone' | 'student_id' | null {
  const id = String(input ?? '').trim();
  if (/^\d{1,4}$/.test(id)) return 'coupon';
  if (normalizePhone(id)) return 'phone';
  return normalizeStudentId(id) ? 'student_id' : null;
}

/** Shown when someone tries to claim a coupon another account already holds or has claimed. */
export const couponTakenMessage = (n: number) =>
  `Coupon ${n} has already been claimed by another account. Check your coupon number and fill in the form again. ` +
  'If this coupon is really yours, tell an admin.';
