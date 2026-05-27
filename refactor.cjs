const fs = require('fs');

const contextFile = 'src/contexts/EphemeralMessagesContext.tsx';
let ctx = fs.readFileSync(contextFile, 'utf8');

// 1. Remove state fields from EphemeralMessagesContextType
ctx = ctx.replace(/  attachmentTransfers: AttachmentTransferState\[\]\r?\n/g, '');
ctx = ctx.replace(/  transferHistory: TransferHistoryEntry\[\]\r?\n/g, '');
ctx = ctx.replace(/  sharedAttachments: SharedAttachmentItem\[\]\r?\n/g, '');

// 2. Replace the massive useMemo `value` block
const useMemoStart = ctx.indexOf('  const value = useMemo(');
if (useMemoStart !== -1) {
  const returnProviderIndex = ctx.indexOf('  return <EphemeralMessagesContext.Provider', useMemoStart);
  
  const proxyCode = `  const fnsRef = useRef<any>({})
  Object.assign(fnsRef.current, {
    getMessages,
    openServerChat,
    getUnreadCount,
    sendMessage,
    sendAttachmentMessage,
    sendMixedMessage,
    addBundlingMessage,
    updateBundlingProgress,
    requestAttachmentDownload,
    hasAccessibleCompletedDownload,
    refreshTransferHistoryAccessibility,
    removeTransferHistoryEntry,
    cancelTransferRequest,
    refreshSharedAttachments,
    unshareAttachmentById,
    notifyAttachmentReshared,
    markSharedInServer,
    isSharedInServer,
    getServersForSha,
    unshareFromServer,
    getCachedPathForSha,
    updateAttachmentAspect,
    findMessageById
  })

  const value = useMemo(() => {
    const proxy: any = {};
    const keys = [
      'getMessages','openServerChat','getUnreadCount','sendMessage','sendAttachmentMessage','sendMixedMessage','addBundlingMessage','updateBundlingProgress','requestAttachmentDownload','hasAccessibleCompletedDownload','refreshTransferHistoryAccessibility','removeTransferHistoryEntry','cancelTransferRequest','refreshSharedAttachments','unshareAttachmentById','notifyAttachmentReshared','markSharedInServer','isSharedInServer','getServersForSha','unshareFromServer','getCachedPathForSha','updateAttachmentAspect','findMessageById'
    ]
    for (const key of keys) {
      proxy[key] = (...args: any[]) => fnsRef.current[key](...args)
    }
    return proxy as EphemeralMessagesContextType
  }, [])\n\n`;

  ctx = ctx.slice(0, useMemoStart) + proxyCode + ctx.slice(returnProviderIndex);
}

fs.writeFileSync(contextFile, ctx);

// Now patch consumers

function replaceConsumer(filePath, replaceRegex, replacement) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(replaceRegex, replacement);
  fs.writeFileSync(filePath, content);
}

// src/pages/ServerViewPage.tsx
replaceConsumer('src/pages/ServerViewPage.tsx', 
  /    attachmentTransfers,\s*transferHistory,\s*sharedAttachments,\s*/,
  ''
);

// We still need to import zustand and use it.
const zustandImport = "import { useEphemeralMessagesStore } from '../stores/ephemeralMessagesStore';\n";

function injectZustandUse(filePath) {
  if (!fs.existsSync(filePath)) return;
  let text = fs.readFileSync(filePath, 'utf8');
  
  if (!text.includes('useEphemeralMessagesStore')) {
    text = text.replace(/import \{.*\} from 'react';?/, (m) => m + "\n" + zustandImport);
    if (!text.includes(zustandImport)) {
       text = zustandImport + text;
    }
  }

  // Inside the component, insert zustand selectors
  // We'll just define them where the context is called
  const contextCallMatch = text.match(/const\s+\{\s*([^}]+)\s*\}\s*=\s*useEphemeralMessages\(\)/);
  if (contextCallMatch) {
    const injected = `const attachmentTransfers = useEphemeralMessagesStore(s => s.attachmentTransfers);
  const transferHistory = useEphemeralMessagesStore(s => s.transferHistory);
  const sharedAttachments = useEphemeralMessagesStore(s => s.sharedAttachments);
  ` + contextCallMatch[0];
    text = text.replace(contextCallMatch[0], injected);
  }

  fs.writeFileSync(filePath, text);
}

// ServerViewPage
injectZustandUse('src/pages/ServerViewPage.tsx');

// TransferCenterButton
replaceConsumer('src/components/TransferCenterButton.tsx', 
  /const { attachmentTransfers } = useEphemeralMessages\(\)/,
  `const attachmentTransfers = useEphemeralMessagesStore(s => s.attachmentTransfers)`
);
let tb = fs.readFileSync('src/components/TransferCenterButton.tsx', 'utf8');
if (!tb.includes('useEphemeralMessagesStore')) {
  fs.writeFileSync('src/components/TransferCenterButton.tsx', zustandImport + tb);
}

// Other consumers: TransferCenterModal don't use the raw array, they probably use context methods, so they are fine? Let's check them manually just in case.

console.log("Refactoring complete.");
