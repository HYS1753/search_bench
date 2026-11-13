import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type Role = "admin" | "editor" | "reviewer" | "viewer";
export interface Me {
  id: number | null;
  username: string;
  name: string;
  role: Role;
  role_label?: string;
}
export interface AuthStatus {
  mode: "open" | "password" | "users";
  required: boolean;
  authenticated: boolean;
  user: Me | null;
}
const ORDER: Record<Role, number> = { viewer: 0, reviewer: 1, editor: 2, admin: 3 };
export const ROLE_LABEL: Record<Role, string> = { admin: "관리자", editor: "편집자", reviewer: "검수자", viewer: "보기 전용" };
export const ROLE_DESC: Record<Role, string> = {
  admin: "모든 기능 + 계정·판정 모델·설정 가져오기·감사 기록",
  editor: "API·평가 기준·비교 세트·테스트 데이터를 만들고 평가를 실행",
  reviewer: "결과 보기 + 사람 검수(등급·목록 선호 매기기)",
  viewer: "결과 보기와 단건 검색 비교만",
};

export function useAuth() {
  return useQuery({ queryKey: ["auth"], queryFn: () => api.get<AuthStatus>("/auth/status"), staleTime: Infinity });
}

/** 이 역할 이상인지(열린 상태면 모두 관리자) */
export function can(me: Me | null | undefined, need: Role): boolean {
  return !!me && ORDER[me.role] >= ORDER[need];
}
