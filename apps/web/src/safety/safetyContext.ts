import { createContext, useContext } from 'react';
import type { SafetyContextValue } from './safetyTypes';

export const SafetyContext = createContext<SafetyContextValue | null>(null);

export function useSafety(): SafetyContextValue {
  const value = useContext(SafetyContext);
  if (!value) throw new Error('useSafety must be used inside a SafetyProvider');
  return value;
}
