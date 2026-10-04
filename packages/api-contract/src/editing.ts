export interface LeaseCredentials { windowId: string; leaseToken: string }
export interface AcquireLeaseRequest { windowId: string; resumeLease?: LeaseCredentials }
export interface LeaseResponse extends LeaseCredentials { expiresAt: number }
