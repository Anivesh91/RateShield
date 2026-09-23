-- SmartRate v2 — Atomic Fixed Window Rate Limiting Script
-- KEYS[1] : The unique rate limit key (e.g. smartrate:POST:/api/login:127.0.0.1)
-- ARGV[1] : Window duration in milliseconds (e.g. 60000)

local count = redis.call("INCR", KEYS[1])

if count == 1 then
    redis.call("PEXPIRE", KEYS[1], ARGV[1])
end

local ttl = redis.call("PTTL", KEYS[1])

return {count, ttl}
