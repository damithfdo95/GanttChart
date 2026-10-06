import { createContext, useContext } from 'react';
import type { PrincipalDto } from '../../shared/tenancy';
import type { TenancyApi } from '../lib/tenancy/api';

export interface TenantApi {
  /** Who the server says this is. null when there is no backend (plain local use). */
  principal: PrincipalDto | null;
  api: TenancyApi | null;
}

const NONE: TenantApi = { principal: null, api: null };

const TenantContext = createContext<TenantApi>(NONE);

export const TenantProvider = TenantContext.Provider;

/** Safe outside a backend: returns { principal: null }. */
export function useTenant(): TenantApi {
  return useContext(TenantContext);
}
