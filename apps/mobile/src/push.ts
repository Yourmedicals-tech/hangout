/**
 * push.ts (client) — asking for the one permission that matters.
 *
 * NOT WIRED UP: this needs `npx expo install expo-notifications expo-device`
 * and an EAS project id, neither of which exist yet (no Expo account — see
 * BUILD_LOG.md). The code is here, correct and commented, because the *timing*
 * of the ask is a product decision and I don't want it made by accident later.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHEN TO ASK. This is the whole thing.
 *
 * Notification permission is a ONE-WAY DOOR. Ask at the wrong moment, get a
 * "Don't Allow", and you are done: you cannot ask again, and the only route
 * back is talking a person through iOS Settings, which nobody has ever done.
 *
 * So DO NOT ask on launch. On launch the person has no idea what this app is,
 * has seen no value, and "Hangout would like to send you notifications" is
 * indistinguishable from every other app begging on day one. You will be
 * declined by most of them, permanently, before you have shown them anything.
 *
 * Ask at the moment the value is OBVIOUS and the person has just felt it:
 * immediately after they JOIN THEIR FIRST GAME. They have just tapped "I'm in".
 * They are, at that instant, a person who wants to know if it falls through.
 * Then the ask writes itself, and it isn't a beg:
 *
 *     "Want to know if someone drops out?"
 *
 * That is not a notification request. That is the product.
 * ───────────────────────────────────────────────────────────────────────────
 */

export interface PushRegistration {
  token: string;
  platform: "ios" | "android" | "web";
}

/**
 * Register for push. Call this ONLY after a moment of felt value — see above.
 * Returns null if the person declines, or if we're on a simulator (which has
 * no push at all, and would otherwise look like a bug for an hour).
 */
export async function registerForPush(): Promise<PushRegistration | null> {
  // --- uncomment once expo-notifications is installed ---
  //
  // import * as Notifications from "expo-notifications";
  // import * as Device from "expo-device";
  // import { Platform } from "react-native";
  //
  // if (!Device.isDevice) return null;          // simulators cannot receive push
  //
  // const existing = await Notifications.getPermissionsAsync();
  // let status = existing.status;
  //
  // // Only ever prompt if we have not been answered. Asking a second time does
  // // nothing on iOS except waste the call.
  // if (status !== "granted") {
  //   const asked = await Notifications.requestPermissionsAsync();
  //   status = asked.status;
  // }
  // if (status !== "granted") return null;      // they said no. Respect it. Do not nag.
  //
  // // Android needs a channel or the notification arrives silently, which is
  // // the same as not arriving.
  // if (Platform.OS === "android") {
  //   await Notifications.setNotificationChannelAsync("spots", {
  //     name: "A spot opened",
  //     importance: Notifications.AndroidImportance.HIGH,
  //     vibrationPattern: [0, 250, 250, 250],
  //   });
  // }
  //
  // const projectId = Constants.expoConfig?.extra?.eas?.projectId;   // ← from EAS
  // const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  // return { token, platform: Platform.OS as PushRegistration["platform"] };

  return null;
}

/**
 * The tap must land on the GAME, not the home screen.
 *
 * A notification that says "someone dropped out of Friday doubles" and then
 * dumps you on a generic feed is a notification that made you do work. The
 * whole value is that it is one tap from "I'm in".
 */
export function gameIdFromNotification(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const id = (data as Record<string, unknown>).gameId;
  return typeof id === "string" ? id : null;
}

/**
 * Has this person already been asked? We only ever want to ask once, at the
 * right moment, and never again.
 */
export function shouldAskForPush(opts: {
  alreadyAsked: boolean;
  gamesJoined: number;
}): boolean {
  if (opts.alreadyAsked) return false;
  // Not on launch. Not on browse. After they have skin in the game — literally.
  return opts.gamesJoined >= 1;
}
