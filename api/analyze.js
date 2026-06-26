import { Readable } from 'node:stream';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SUPPORTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const normalizeScore = (value) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value <= 1 ? value * 100 : value)));
};

const getExtension = (name = '') => name.split('.').pop()?.toLowerCase() || '';

const isSupportedFile = (file) => {
  return SUPPORTED_TYPES.has(file.type) || SUPPORTED_EXTENSIONS.has(getExtension(file.name));
};

const normalizeDetectorResponse = (payload) => {
  const rawScore =
    payload.aiScore ??
    payload.ai_score ??
    payload.ai_probability ??
    payload.probability ??
    payload.score ??
    payload.result?.aiScore ??
    payload.result?.ai_score;

  const aiScore = normalizeScore(rawScore);
  if (aiScore === null) {
    throw new Error('AI detector response does not include a usable score.');
  }

  const reasons =
    payload.reasons ??
    payload.reason_codes ??
    payload.explanations ??
    payload.result?.reasons ??
    [];

  return {
    aiScore,
    realScore: 100 - aiScore,
    isDeepfake: typeof payload.isDeepfake === 'boolean' ? payload.isDeepfake : aiScore > 50,
    source: 'api',
    reasons: Array.isArray(reasons) && reasons.length > 0
      ? reasons.map(String)
      : ['External AI detector API returned a score.'],
  };
};

const buildHeaders = (headers) => {
  const result = new Headers();
  Object.entries(headers).forEach(([key, value]) => {
    if (typeof value === 'string') {
      result.set(key, value);
    } else if (Array.isArray(value)) {
      result.set(key, value.join(', '));
    }
  });
  return result;
};

const parseRequestForm = async (req) => {
  const host = req.headers.host || 'localhost';
  const request = new Request(`https://${host}${req.url}`, {
    method: req.method,
    headers: buildHeaders(req.headers),
    body: Readable.toWeb(req),
    duplex: 'half',
  });

  return request.formData();
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'method_not_allowed', message: 'Only POST is supported.' });
  }

  const apiKey = process.env.AI_DETECTOR_API_KEY;
  const detectorUrl = process.env.AI_DETECTOR_API_URL;

  if (!apiKey) {
    return json(res, 500, { error: 'missing_api_key', message: 'AI_DETECTOR_API_KEY is not configured.' });
  }

  if (!detectorUrl) {
    return json(res, 500, { error: 'missing_api_url', message: 'AI_DETECTOR_API_URL is not configured.' });
  }

  try {
    const formData = await parseRequestForm(req);
    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return json(res, 400, { error: 'missing_file', message: 'FormData field "file" is required.' });
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return json(res, 413, { error: 'file_too_large', message: 'File size must not exceed 50 MB.' });
    }

    if (!isSupportedFile(file)) {
      return json(res, 415, { error: 'unsupported_file', message: 'Only JPG, PNG, and WEBP images are supported by the API detector.' });
    }

    const upstreamForm = new FormData();
    upstreamForm.append('file', file, file.name || 'upload');

    const upstreamResponse = await fetch(detectorUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: upstreamForm,
    });

    if (!upstreamResponse.ok) {
      const details = await upstreamResponse.text().catch(() => '');
      return json(res, 502, {
        error: 'detector_api_error',
        message: 'External AI detector API returned an error.',
        status: upstreamResponse.status,
        details: details.slice(0, 500),
      });
    }

    const payload = await upstreamResponse.json();
    return json(res, 200, normalizeDetectorResponse(payload));
  } catch (error) {
    return json(res, 502, {
      error: 'network_or_parse_error',
      message: error instanceof Error ? error.message : 'External AI detector API is unavailable.',
    });
  }
}
