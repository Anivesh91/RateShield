-- SmartRate v4 — Atomic Token Bucket Rate Limiting Script (Redis Hash)
-- KEYS[1] : Unique rate limit key (e.g. smartrate:token-bucket:GET:/api/data:user_123)
-- ARGV[1] : Current timestamp in milliseconds (now)
-- ARGV[2] : Maximum bucket capacity (capacity)
-- ARGV[3] : Refill rate in tokens per second (refillRate)
-- ARGV[4] : Request cost in tokens (cost)

local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local cost = tonumber(ARGV[4]) or 1

-- 1. Read existing bucket state atomically from Redis Hash
local data = redis.call("HMGET", key, "tokens", "lastRefill")
local rawTokens = data[1]
local rawLastRefill = data[2]

local currentTokens = capacity
local lastRefill = now

if rawTokens and rawLastRefill then
    local prevTokens = tonumber(rawTokens)
    local prevLastRefill = tonumber(rawLastRefill)

    -- Continuous refill calculation based on elapsed milliseconds
    local elapsedMs = math.max(0, now - prevLastRefill)
    local tokensToAdd = (elapsedMs / 1000) * refillRate
    currentTokens = math.min(capacity, prevTokens + tokensToAdd)
    lastRefill = now
end

local allowed = 0
local remaining = 0
local retryAfter = 0

-- 2. Check token availability and consume tokens if sufficient
if currentTokens >= cost then
    currentTokens = currentTokens - cost
    allowed = 1
    remaining = math.floor(currentTokens)
    lastRefill = now
else
    allowed = 0
    remaining = math.floor(currentTokens)
    local neededTokens = cost - currentTokens
    retryAfter = math.max(1, math.ceil(neededTokens / refillRate))
end

-- 3. Update bucket state in Redis
redis.call("HSET", key, "tokens", tostring(currentTokens), "lastRefill", tostring(lastRefill))

-- 4. Set TTL so inactive buckets automatically expire from Redis
-- TTL is twice the time it takes to refill an empty bucket to full, with a minimum of 60 seconds
local fullTimeSec = math.ceil(capacity / refillRate)
local ttlSeconds = math.max(60, fullTimeSec * 2)
redis.call("EXPIRE", key, ttlSeconds)

-- 5. Calculate reset (seconds until bucket is completely full again)
local reset = math.max(1, math.ceil((capacity - currentTokens) / refillRate))

-- Return: [ allowed (1 or 0), remaining, reset, retryAfter ]
return { allowed, remaining, reset, retryAfter }
