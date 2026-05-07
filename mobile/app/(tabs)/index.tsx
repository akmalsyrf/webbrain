import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { useAgent } from '@/context/AgentContext';

export default function ChatScreen() {
  const { messages, working, sendMessage } = useAgent();
  const [draft, setDraft] = useState('');
  const isDark = (useColorScheme() ?? 'light') === 'dark';
  const scrollRef = useRef<ScrollView>(null);

  // Auto-scroll to bottom on new messages — same UX as iMessage / chat apps.
  useEffect(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length, working]);

  function onSend() {
    const text = draft.trim();
    if (!text) return;
    sendMessage(text);
    setDraft('');
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
      keyboardVerticalOffset={90}>
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        keyboardDismissMode="interactive">
        {messages.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>WebBrain Mobile</Text>
            <Text style={styles.emptyHint}>
              Ask the agent to do something. Tap the gear (top right) to add your API key first.
            </Text>
          </View>
        )}
        {messages.map((m) => {
          if (m.role === 'tool') {
            return (
              <RNView key={m.id} style={styles.toolRow}>
                <Text style={[styles.toolText, !m.ok && styles.toolTextError]}>
                  {m.ok ? '·' : '⚠'} {m.label}
                </Text>
              </RNView>
            );
          }
          return (
            <RNView
              key={m.id}
              style={[
                styles.bubble,
                m.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant,
              ]}>
              <Text style={m.role === 'user' ? styles.userText : undefined}>{m.content}</Text>
            </RNView>
          );
        })}
        {working && (
          <RNView style={[styles.bubble, styles.bubbleAssistant]}>
            <Text style={styles.workingText}>working…</Text>
          </RNView>
        )}
      </ScrollView>

      <RNView
        style={[
          styles.inputRow,
          { borderTopColor: isDark ? '#333' : '#ddd' },
        ]}>
        <TextInput
          style={[
            styles.input,
            {
              color: isDark ? '#fff' : '#000',
              backgroundColor: isDark ? '#222' : '#f0f0f0',
            },
          ]}
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask WebBrain to do something…"
          placeholderTextColor={isDark ? '#888' : '#999'}
          multiline
          editable={!working}
        />
        <Pressable
          style={[styles.sendButton, working && styles.sendButtonDisabled]}
          onPress={onSend}
          disabled={working}>
          <Text style={styles.sendButtonText}>Send</Text>
        </Pressable>
      </RNView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  messages: { flex: 1 },
  messagesContent: { padding: 12, gap: 8 },
  empty: { alignItems: 'center', marginTop: 40, gap: 8, backgroundColor: 'transparent' },
  emptyTitle: { fontSize: 22, fontWeight: 'bold' },
  emptyHint: {
    fontSize: 14,
    opacity: 0.6,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  bubble: { padding: 10, borderRadius: 12, maxWidth: '85%' },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#2f95dc' },
  bubbleAssistant: { alignSelf: 'flex-start', backgroundColor: 'rgba(127,127,127,0.18)' },
  userText: { color: '#fff' },
  workingText: { fontStyle: 'italic', opacity: 0.7 },
  toolRow: { paddingVertical: 2, paddingHorizontal: 4 },
  toolText: { fontSize: 12, opacity: 0.55, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) },
  toolTextError: { color: '#d33', opacity: 0.85 },
  inputRow: {
    flexDirection: 'row',
    padding: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
  },
  sendButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: '#2f95dc',
  },
  sendButtonDisabled: { opacity: 0.5 },
  sendButtonText: { color: '#fff', fontWeight: '600' },
});
