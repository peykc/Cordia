const fs = require('fs');

const path = 'src/contexts/EphemeralMessagesContext.tsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Remove reactive hooks at the top of EphemeralMessagesProvider
content = content.replace(
  'const messagesByBucket = useEphemeralMessagesStore((s) => s.messagesByBucket)',
  'const storeRef = useRef(useEphemeralMessagesStore.getState());\n  useEffect(() => useEphemeralMessagesStore.subscribe(s => storeRef.current = s), []);\n'
);
content = content.replace('const [unreadState, setUnreadState] = useState<UnreadState>({\n    unread_count_by_server: {},\n    last_seen_at_by_server: {},\n  })', 'const setUnreadState = useEphemeralMessagesStore((s) => s.setUnreadState);');
content = content.replace('const attachmentTransfers = useEphemeralMessagesStore((s) => s.attachmentTransfers)\n', '');
content = content.replace('const transferHistory = useEphemeralMessagesStore((s) => s.transferHistory)\n', '');
content = content.replace('const sharedAttachments = useEphemeralMessagesStore((s) => s.sharedAttachments)\n', '');
content = content.replace('const serverSharedSha = useEphemeralMessagesStore((s) => s.serverSharedSha)\n', '');
content = content.replace('const contentCacheBySha = useEphemeralMessagesStore((s) => s.contentCacheBySha)\n', '');

// 2. Add imports
content = content.replace(
  "import { useEphemeralMessagesStore } from '../stores/ephemeralMessagesStore'",
  "import { useEphemeralMessagesStore, type MessageBuckets, type UnreadState } from '../stores/ephemeralMessagesStore'"
);

// Remove the local type definitions that are now in the store
content = content.replace('type MessageBuckets = Record<string, EphemeralChatMessage[]>', '');
content = content.replace(/type UnreadState = \{[\s\S]*?\}/, '');

// 3. Replace usages of state inside the file with storeRef.current.VARNAME
// We must be careful not to replace destructuring or types.
// But wait, there's no destructuring of these exact names from parameters (except possibly prev in setters).
// Actually, `messagesByBucket` is used as a plain variable inside functions.
['messagesByBucket', 'attachmentTransfers', 'transferHistory', 'sharedAttachments', 'serverSharedSha', 'contentCacheBySha', 'unreadState'].forEach(v => {
  // Replace only standalone identifiers
  // Negative lookbehind for `.` prevents replacing `s.messagesByBucket`
  // Negative lookbehind for a-zA-Z0-9_ prevents replacing `somemessagesByBucket`
  // Negative lookahead for `:` prevents replacing object keys like `messagesByBucket: foo`
  content = content.replace(new RegExp(`(?<![a-zA-Z0-9_.])(${v})(?![a-zA-Z0-9_:() ])`, 'g'), `storeRef.current.$1`);
  // Handle explicit method calls
  content = content.replace(new RegExp(`(?<![a-zA-Z0-9_.])(${v})\\.`, 'g'), `storeRef.current.$1.`);
  content = content.replace(new RegExp(`(?<![a-zA-Z0-9_.])(${v})\\[`, 'g'), `storeRef.current.$1[`);
});

// 4. Remove exported state from context
content = content.replace(`attachmentTransfers: AttachmentTransferState[]\n  transferHistory: TransferHistoryEntry[]\n  `, '');
content = content.replace(`sharedAttachments: SharedAttachmentItem[]\n  `, '');

content = content.replace(`attachmentTransfers,\n      transferHistory,\n      `, '');
content = content.replace(`sharedAttachments,\n      `, '');

fs.writeFileSync(path, content);
console.log('Done refactoring');
