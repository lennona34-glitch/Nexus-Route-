export async function fetchWebpageContent(url: string, maxLength = 12000): Promise<{ success: boolean; url: string; title: string; text: string; error?: string }> {
  try {
    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return { success: false, url: targetUrl, title: '', text: '', error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const html = await res.text();

    // Extract Title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'Webpage';

    // Strip scripts, styles, svgs, noscripts, iframes
    let clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '');

    // Convert Headings
    clean = clean.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
    clean = clean.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
    clean = clean.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
    clean = clean.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n');

    // Convert Links and List items
    clean = clean.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n* $1');
    clean = clean.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
    clean = clean.replace(/<br\s*\/?>/gi, '\n');

    // Strip all remaining HTML tags
    clean = clean.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    clean = clean
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&copy;/g, '©');

    // Collapse whitespace and multiple line breaks
    clean = clean
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();

    if (clean.length > maxLength) {
      clean = clean.slice(0, maxLength) + `\n\n... [Content truncated at ${maxLength} characters]`;
    }

    return {
      success: true,
      url: targetUrl,
      title,
      text: clean || 'No readable text content extracted from page.',
    };
  } catch (err: unknown) {
    return {
      success: false,
      url,
      title: '',
      text: '',
      error: (err as Error).message,
    };
  }
}
