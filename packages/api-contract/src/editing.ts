export interface LeaseCredentials { windowId: string; leaseToken: string }
export interface AcquireLeaseRequest { windowId: string }
export interface LeaseResponse extends LeaseCredentials { expiresAt: number }
