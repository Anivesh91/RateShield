/**
 * Demo Controllers
 *
 * NOTE: These are intentionally simple/fake controllers representing normal API business logic.
 * They exist solely to prove that when SmartRate permits a request, the downstream controller executes.
 * There is NO database, NO authentication, NO JWT, and NO User model.
 */

/**
 * Controller for GET /api/test (Permits 5 requests / 60 seconds).
 */
export function testController(req, res) {
  return res.status(200).json({
    success: true,
    message: 'Test endpoint reached successfully'
  });
}

/**
 * Controller for POST /api/login (Permits 3 requests / 60 seconds).
 * Fake login demonstration endpoint.
 */
export function loginController(req, res) {
  return res.status(200).json({
    success: true,
    message: 'Fake login request accepted'
  });
}

/**
 * Controller for GET /api/public (Permits 10 requests / 60 seconds).
 */
export function publicController(req, res) {
  return res.status(200).json({
    success: true,
    message: 'Public endpoint reached successfully'
  });
}
