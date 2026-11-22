// "Turn on notifications to get liquidation alerts": asked right after the user opens a position,
// only while notifications are OFF for the app, at most once per 30 days.
import { Linking, PermissionsAndroid, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import messaging from "@react-native-firebase/messaging";
import notifee, { AuthorizationStatus } from "@notifee/react-native";
import { PERPS_ENABLED } from "../config";
import { showInfo } from "../utils/modalSafe";
import { logPerpsError } from "../utils/perpsLog";

const SNOOZE_KEY = "perpsAlerts:promptSnoozeUntil";
export const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export const notificationsOn = async () => {
  const s = await notifee.getNotificationSettings();
  return (
    s.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    s.authorizationStatus === AuthorizationStatus.PROVISIONAL
  );
};

const openSettings = () => Linking.openSettings().catch(() => {});

// Ask the OS; if it will not show its own dialog any more (permanently denied, or Android < 13
// where the switch lives in Settings), open the app's settings page instead.
export const turnOnNotifications = async () => {
  try {
    if (Platform.OS === "android") {
      if (Platform.Version >= 33) {
        const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
        if (r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return openSettings();
        if (r === PermissionsAndroid.RESULTS.GRANTED && !(await notificationsOn())) return openSettings();
        return undefined;
      }
      return openSettings();
    }
    const status = await messaging().requestPermission();
    if (status === messaging.AuthorizationStatus.DENIED) return openSettings();
  } catch (e) {
    logPerpsError({ step: "alerts:permission", msg: e && e.message });
  }
  return undefined;
};

// Call after a position was opened. Never throws.
export const maybeAskForAlertsPermission = async () => {
  try {
    if (!PERPS_ENABLED) return;
    if (await notificationsOn()) return;
    const until = Number(await AsyncStorage.getItem(SNOOZE_KEY).catch(() => null)) || 0;
    if (Date.now() < until) return;
    // Asked once: whatever the answer, not again for 30 days.
    await AsyncStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)).catch(() => {});
    showInfo(
      "info",
      "Liquidation alerts",
      "Turn on notifications to get liquidation alerts",
      [
        { text: "Not now", style: "cancel" },
        { text: "Turn on", onPress: () => turnOnNotifications() },
      ]
    );
  } catch (e) {
    logPerpsError({ step: "alerts:prompt", msg: e && e.message });
  }
};
