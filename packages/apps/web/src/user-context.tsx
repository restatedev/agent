"use client";
import type {UserProfile} from "@restate-agents/types";
import {createContext, useContext} from "react";
export const UserContext = createContext<{
  profile: UserProfile;
  refresh: () => Promise<void>;
} | null>(null);
export function useUser() {
  const user = useContext(UserContext);
  if (!user) throw new Error("User workspace required");
  return user;
}
