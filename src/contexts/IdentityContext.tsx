import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { UserIdentity, hasIdentity, loadIdentity, createIdentity, importIdentity } from '../lib/tauri';

interface IdentityContextType {
  identity: UserIdentity | null;
  isLoading: boolean;
  hasStoredIdentity: boolean;
  createIdentity: (displayName: string) => Promise<void>;
  restoreIdentity: (data: Uint8Array) => Promise<void>;
  logout: () => void;
}

const IdentityContext = createContext<IdentityContextType | undefined>(undefined);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasStoredIdentity, setHasStoredIdentity] = useState(false);

  useEffect(() => {
    checkIdentity();
  }, []);

  async function checkIdentity() {
    try {
      const exists = await hasIdentity();
      setHasStoredIdentity(exists);
      
      // Auto-load identity if it exists (passwordless)
      if (exists) {
        try {
          const userIdentity = await loadIdentity();
          setIdentity(userIdentity);
        } catch (error) {
          console.error('Failed to load identity:', error);
          // Identity file exists but is corrupted
          setHasStoredIdentity(false);
        }
      }
    } catch (error) {
      console.error('Failed to check identity:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function createIdentityHandler(displayName: string) {
    try {
      const userIdentity = await createIdentity(displayName);
      setIdentity(userIdentity);
      setHasStoredIdentity(true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Failed to create identity:', errorMessage);
      throw new Error(errorMessage || 'Failed to create identity');
    }
  }

  async function restoreIdentity(data: Uint8Array) {
    try {
      const userIdentity = await importIdentity(data);
      setIdentity(userIdentity);
      setHasStoredIdentity(true);
    } catch (error) {
      throw new Error('Failed to import identity. The file may be corrupted or invalid.');
    }
  }

  function logout() {
    setIdentity(null);
    // Note: keys.dat remains on disk, just cleared from memory
  }

  return (
    <IdentityContext.Provider
      value={{
        identity,
        isLoading,
        hasStoredIdentity,
        createIdentity: createIdentityHandler,
        restoreIdentity,
        logout,
      }}
    >
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentity() {
  const context = useContext(IdentityContext);
  if (context === undefined) {
    throw new Error('useIdentity must be used within an IdentityProvider');
  }
  return context;
}

