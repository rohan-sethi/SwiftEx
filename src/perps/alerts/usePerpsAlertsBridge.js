// App-level part of Perps liquidation alerts, mounted once by the Home tab navigator (after the
// PIN unlock):
//  - upload the open positions when the app starts and every time it comes back to the front
//    (throttled in syncPerpsAlerts; skipped when the wallet has no Perps trading key);
//  - open the Perps tab (and highlight the position) when a liquidation alert was tapped.
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import notifee, { EventType } from "@notifee/react-native";
import { PERPS_ENABLED } from "../config";
import { useMainEvmAddress } from "../hooks/usePerpsAgent";
import { requestFocus } from "../utils/positionFocus";
import { syncPerpsAlerts } from "./alertsClient";
import { notePerpsAlertOpened, takePendingPerpsOpen, onPerpsOpenRequest } from "./notificationRoute";

export const usePerpsAlertsBridge = ({ navigation, perpsVisible }) => {
  const user = useMainEvmAddress();

  useEffect(() => {
    if (!PERPS_ENABLED || !user) return undefined;
    syncPerpsAlerts({ reason: "app-start", user });
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") syncPerpsAlerts({ reason: "foreground", user });
    });
    return () => sub.remove();
  }, [user]);

  // Taps on alerts shown by notifee (foreground messages / data-only messages). Only acts on
  // liquidation alerts; other notifications keep their current behaviour.
  useEffect(() => {
    if (!PERPS_ENABLED) return undefined;
    notifee
      .getInitialNotification()
      .then((initial) => {
        if (initial && initial.notification) notePerpsAlertOpened(initial.notification);
      })
      .catch(() => {});
    return notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.PRESS && detail && detail.notification) notePerpsAlertOpened(detail.notification);
    });
  }, []);

  const visibleRef = useRef(perpsVisible);
  visibleRef.current = perpsVisible;
  useEffect(() => {
    if (!PERPS_ENABLED || !perpsVisible) return undefined;
    const open = () => {
      if (!visibleRef.current) return;
      const p = takePendingPerpsOpen();
      if (!p) return;
      navigation.navigate("HomeScreen", { screen: "Perps" });
      // Same highlight as the order sheet's "View position" (expires if the row never appears).
      if (p.symbol) requestFocus({ kind: "position", symbol: p.symbol, strength: "strong" });
    };
    open(); // a tap recorded before the tabs were ready (cold start)
    return onPerpsOpenRequest(open);
  }, [perpsVisible, navigation]);
};
