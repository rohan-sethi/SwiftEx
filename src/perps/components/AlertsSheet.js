import React, { useEffect, useMemo, useState } from "react";
import { AppState, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Modal from "react-native-modal";
import Icon from "../../icon";
import { useModalPresence } from "../utils/modalSafe";
import { alertsViewFrom, setPerpsAlertMuted, setPerpsAlertsEnabled } from "../alerts/alertsClient";
import { loadAlertPrefs, onAlertPrefsChange } from "../alerts/prefs";
import { notificationsOn, turnOnNotifications } from "../alerts/notificationPrompt";

const FOOTER =
  "You'll get an alert at 70%, 90% and 100% margin ratio (100% = liquidation). Prices are checked every few seconds. Alerts need the app opened at least once a day.";

const baseOf = (symbol) => String(symbol || "").replace(/(USDT|USDC|USD1|USD)$/, "");
const pct = (r) => (Number.isFinite(r) ? `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%` : "≥100%");
const ratioColor = (r, theme) => (!(r < 0.9) ? theme.fail : r >= 0.7 ? theme.warn : theme.headingTx);

// Per-wallet alert settings for the Perps tab. raw = the account poller's last { account, positionRisk }.
const AlertsSheet = ({ visible, onClose, theme, user, raw }) => {
  const presence = useModalPresence(visible);
  const { height } = useWindowDimensions();
  const [prefs, setPrefs] = useState(null); // { enabled, muted }
  const [notifOn, setNotifOn] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    loadAlertPrefs(user).then((p) => alive && setPrefs(p));
    const off = onAlertPrefsChange((w, p) => {
      if (alive && w === String(user).toLowerCase()) setPrefs(p);
    });
    return () => {
      alive = false;
      off();
    };
  }, [user]);

  // System notification switch: checked when the sheet opens and on return from Settings.
  useEffect(() => {
    if (!visible) return undefined;
    const check = () => notificationsOn().then(setNotifOn).catch(() => {});
    check();
    const sub = AppState.addEventListener("change", (s) => s === "active" && check());
    return () => sub.remove();
  }, [visible]);

  const view = useMemo(() => alertsViewFrom(raw), [raw]);
  const enabled = prefs ? prefs.enabled : true;
  const muted = new Set(prefs ? prefs.muted : []);
  const rows = [
    ...(view.cross
      ? [{ key: view.cross.key, title: "Cross positions", sub: view.cross.symbols.map(baseOf).join(", "), ratio: view.cross.ratio }]
      : []),
    ...view.isolated.map((r) => ({
      key: r.key,
      title: `${baseOf(r.symbol)} ${r.side === "LONG" ? "Long" : "Short"} · Isolated`,
      sub: null,
      ratio: r.ratio,
    })),
  ];

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isVisible={visible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      style={styles.modal}
      useNativeDriverForBackdrop
      onModalHide={presence.onModalHide}
    >
      <View style={[styles.sheet, { backgroundColor: theme.bg, maxHeight: Math.round(height * 0.85) }]}>
        <View style={styles.headRow}>
          <Text accessibilityRole="header" style={[styles.title, { color: theme.headingTx }]}>
            Liquidation alerts
          </Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12}>
            <Icon name="close" type="ionicon" size={24} color={theme.inactiveTx} />
          </TouchableOpacity>
        </View>

        <View style={[styles.card, { backgroundColor: theme.cardBg }]}>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: theme.headingTx }]}>Liquidation alerts</Text>
              <Text style={[styles.rowSub, { color: theme.inactiveTx }]}>{enabled ? "On" : "Off"}</Text>
            </View>
            <Switch
              accessibilityLabel="Liquidation alerts"
              value={enabled}
              disabled={!prefs || busy || !user}
              onValueChange={(v) => run(() => setPerpsAlertsEnabled(user, v))}
              trackColor={{ true: theme.buttonColor }}
            />
          </View>
        </View>

        {!notifOn ? (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => turnOnNotifications()}
            style={[styles.card, styles.row, { backgroundColor: theme.cardBg }]}
          >
            <Icon name="notifications-off-outline" type="ionicon" size={20} color={theme.warn} />
            <Text style={[styles.rowSub, styles.notifTxt, { color: theme.headingTx }]}>
              Notifications are off on this phone
            </Text>
            <Text style={[styles.link, { color: theme.buttonColor }]}>Turn on</Text>
          </TouchableOpacity>
        ) : null}

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {rows.length === 0 ? (
            <Text style={[styles.empty, { color: theme.inactiveTx }]}>
              No open positions. Alerts start automatically when you open one.
            </Text>
          ) : (
            <View style={[styles.card, { backgroundColor: theme.cardBg, opacity: enabled ? 1 : 0.5 }]}>
              {rows.map((r, i) => (
                <View key={r.key} style={[styles.row, i > 0 && [styles.divider, { borderTopColor: theme.smallCardBorderColor }]]}>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: theme.headingTx }]}>{r.title}</Text>
                    {r.sub ? (
                      <Text numberOfLines={2} style={[styles.rowSub, { color: theme.inactiveTx }]}>
                        {r.sub}
                      </Text>
                    ) : null}
                    <Text style={[styles.rowSub, { color: theme.inactiveTx }]}>
                      Margin ratio{" "}
                      <Text style={[styles.ratio, { color: ratioColor(r.ratio, theme) }]}>{pct(r.ratio)}</Text>
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel={`Alerts for ${r.title}`}
                    value={!muted.has(r.key)}
                    disabled={!enabled || busy || !prefs}
                    onValueChange={(on) => run(() => setPerpsAlertMuted(user, r.key, !on))}
                    trackColor={{ true: theme.buttonColor }}
                  />
                </View>
              ))}
            </View>
          )}
          <Text style={[styles.footer, { color: theme.inactiveTx }]}>{FOOTER}</Text>
        </ScrollView>
      </View>
    </Modal>
  );
};

export default AlertsSheet;

const styles = StyleSheet.create({
  modal: { justifyContent: "flex-end", margin: 0 },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 28 },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  title: { fontSize: 20, fontWeight: "800", flexShrink: 1 },
  card: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 4, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, marginRight: 12 },
  rowTitle: { fontSize: 15, fontWeight: "700" },
  rowSub: { fontSize: 13, marginTop: 2, lineHeight: 18 },
  ratio: { fontWeight: "700" },
  notifTxt: { flex: 1, marginLeft: 10, marginTop: 0 },
  link: { fontSize: 14, fontWeight: "700", marginLeft: 8 },
  list: { flexGrow: 0 },
  listContent: { paddingBottom: 4 },
  empty: { fontSize: 14, lineHeight: 20, textAlign: "center", paddingVertical: 18, paddingHorizontal: 8 },
  footer: { fontSize: 12, lineHeight: 17, marginTop: 4 },
});
