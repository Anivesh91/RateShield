export function testController(req, res) {
  res.json({
    success: true,
    message: 'Test endpoint reached successfully'
  });
}

export function loginController(req, res) {
  res.json({
    success: true,
    message: 'Fake login request accepted'
  });
}

export function publicController(req, res) {
  res.json({
    success: true,
    message: 'Public endpoint reached successfully'
  });
}
