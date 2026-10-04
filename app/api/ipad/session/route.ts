import { NextResponse } from 'next/server';
import { deviceFromRequest, issueDeviceToken, revokeDevice, verifyPassword } from '@/lib/ipad-sync';

/* Sign-in for the offline iPad app. It can't share the website's cookie
   session (iOS gives Home Screen apps their own cookie jar), so it trades an
   email and password for a long-lived device key once. */

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  const device = String(body?.device ?? '').trim().slice(0, 80) || 'iPad';
  if (!email || !password) {
    return NextResponse.json({ error: 'Enter your email and password.' }, { status: 400 });
  }

  const user = await verifyPassword(email, password);
  if (!user) {
    // A flat delay takes the edge off password guessing.
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: 'That email and password don’t match an account.' }, { status: 401 });
  }

  const token = await issueDeviceToken(user.id, device);
  return NextResponse.json({ token, email: user.email, name: user.name }, { headers: { 'Cache-Control': 'no-store' } });
}

/** Sign out: the key stops working immediately. */
export async function DELETE(req: Request) {
  const device = await deviceFromRequest(req);
  if (device) await revokeDevice(device.tokenId);
  return NextResponse.json({ ok: true });
}
