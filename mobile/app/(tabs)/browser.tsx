import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { useAgent } from '@/context/AgentContext';
import { PAGE_SCRIPT } from '@/agent/inject';

export default function BrowserScreen() {
  const { url, setUrl, working, registerWebView, onWebViewMessage } = useAgent();
  const [draft, setDraft] = useState(url);
  const [loading, setLoading] = useState(false);
  const webRef = useRef<WebView>(null);
  const isDark = (useColorScheme() ?? 'light') === 'dark';

  // Register the WebView with the agent context so tools can reach it.
  // Using a callback ref guarantees we register the actual mounted instance.
  useEffect(() => {
    registerWebView(webRef.current);
    return () => registerWebView(null);
  }, [registerWebView]);

  // Keep the URL bar text in sync if the agent navigates the WebView.
  useEffect(() => {
    setDraft(url);
  }, [url]);

  function go() {
    let u = draft.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    setUrl(u);
    setDraft(u);
  }

  function handleMessage(event: WebViewMessageEvent) {
    onWebViewMessage(event.nativeEvent.data);
  }

  return (
    <View style={styles.container}>
      <RNView
        style={[
          styles.urlBar,
          { borderBottomColor: isDark ? '#333' : '#ddd' },
        ]}>
        <TextInput
          style={[
            styles.urlInput,
            {
              color: isDark ? '#fff' : '#000',
              backgroundColor: isDark ? '#222' : '#f0f0f0',
            },
          ]}
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={go}
          placeholder="https://…"
          placeholderTextColor={isDark ? '#888' : '#999'}
          returnKeyType="go"
        />
        <Pressable style={styles.goButton} onPress={go}>
          <Text style={styles.goButtonText}>Go</Text>
        </Pressable>
      </RNView>

      {(loading || working) && <ActivityIndicator style={styles.spinner} />}

      <WebView
        ref={webRef}
        source={{ uri: url }}
        style={styles.webview}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onNavigationStateChange={(navState) => {
          // Reflect in-page navigation in the URL bar without firing setUrl
          // (which would re-trigger the WebView source).
          setDraft(navState.url);
        }}
        onMessage={handleMessage}
        injectedJavaScriptBeforeContentLoaded={PAGE_SCRIPT}
        // Re-inject after every load so SPA route changes that wipe window
        // state still get the AX tree + RPC handlers.
        injectedJavaScript={PAGE_SCRIPT}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        // iOS / Android both need this for postMessage from page → RN.
        // (iOS: messagingEnabled is enabled implicitly when onMessage is set.)
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  urlBar: {
    flexDirection: 'row',
    padding: 8,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  urlInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
  },
  goButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: '#2f95dc',
  },
  goButtonText: { color: '#fff', fontWeight: '600' },
  spinner: { paddingVertical: 4 },
  webview: { flex: 1 },
});
