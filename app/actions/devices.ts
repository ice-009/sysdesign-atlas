'use server';

import { revalidatePath } from 'next/cache';
import { currentUserId } from '@/lib/auth';
import { revokeDevice } from '@/lib/ipad-sync';

/** Sign a device out of the offline iPad app from the website. */
export async function revokeDeviceAction(formData: FormData) {
  const userId = await currentUserId();
  const id = String(formData.get('id') ?? '');
  if (!userId || !id) return;
  // Scoped to the signed-in user, so one account can't revoke another's keys.
  await revokeDevice(id, userId);
  revalidatePath('/account');
}
