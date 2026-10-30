/**
 * RAIA AGENTES • Unified Analytics, UTM Tracking & LGPD Consent Engine
 */
(function () {
  'use strict';

  // 1. Visitor ID Management
  function getVisitorId() {
    let vid = localStorage.getItem('raia_vid');
    if (!vid) {
      vid = 'vid_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
      localStorage.setItem('raia_vid', vid);
    }
    return vid;
  }

  // 2. UTM & Attribution Capture
  function captureUtmParams() {
    const urlParams = new URLSearchParams(window.location.search);
    const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'sck'];
    const captured = {};

    let hasUtm = false;
    utmKeys.forEach(function (k) {
      const val = urlParams.get(k);
      if (val) {
        captured[k] = val;
        hasUtm = true;
      }
    });

    if (hasUtm) {
      sessionStorage.setItem('raia_current_utms', JSON.stringify(captured));
      // First-touch attribution
      if (!localStorage.getItem('raia_first_utms')) {
        localStorage.setItem('raia_first_utms', JSON.stringify(captured));
      }
      // Last-touch attribution
      localStorage.setItem('raia_last_utms', JSON.stringify(captured));
    }

    // Retrieve active UTMs (current session > last touch)
    const active = sessionStorage.getItem('raia_current_utms') || localStorage.getItem('raia_last_utms');
    return active ? JSON.parse(active) : {};
  }

  const activeUtms = captureUtmParams();
  const visitorId = getVisitorId();

  // 3. Dispatch Event to Server
  function trackServerEvent(eventName, metadata) {
    try {
      const payload = {
        eventName: eventName,
        visitorId: visitorId,
        utmSource: activeUtms.utm_source || activeUtms.src || null,
        utmMedium: activeUtms.utm_medium || null,
        utmCampaign: activeUtms.utm_campaign || null,
        utmContent: activeUtms.utm_content || null,
        utmTerm: activeUtms.utm_term || activeUtms.sck || null,
        src: activeUtms.src || null,
        sck: activeUtms.sck || null,
        pageUrl: window.location.href,
        referrer: document.referrer || null,
        metadata: metadata || null,
      };

      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon('/api/analytics/event', blob);
      } else {
        fetch('/api/analytics/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(function () {});
      }
    } catch (e) {}
  }

  // 4. Global Helper
  window.raiaTrackEvent = function (eventName, metadata) {
    trackServerEvent(eventName, metadata);

    // Also forward to Google Analytics if loaded
    if (typeof window.gtag === 'function') {
      window.gtag('event', eventName, metadata || {});
    }

    // Also forward to Meta Pixel if loaded
    if (typeof window.fbq === 'function') {
      if (eventName === 'demo_requested') window.fbq('track', 'Lead', metadata || {});
      else if (eventName === 'initiate_checkout') window.fbq('track', 'InitiateCheckout', metadata || {});
      else window.fbq('trackCustom', eventName, metadata || {});
    }
  };

  // 5. Automatic WhatsApp & Checkout Link Listeners
  document.addEventListener('DOMContentLoaded', function () {
    // Track initial page view
    trackServerEvent('page_view', { title: document.title });

    // Track clicks on WhatsApp buttons
    document.addEventListener('click', function (e) {
      const link = e.target.closest('a');
      if (!link) return;

      const href = link.getAttribute('href') || '';
      if (href.includes('wa.me') || href.includes('whatsapp.com') || href.includes('api.whatsapp.com')) {
        window.raiaTrackEvent('click_whatsapp', {
          href: href,
          buttonText: link.innerText ? link.innerText.trim() : 'Icon',
        });
      }

      if (href.includes('hotmart.com') || href.includes('pay.hotmart.com')) {
        window.raiaTrackEvent('initiate_checkout', {
          href: href,
          targetPlan: href.includes('pro') ? 'JESSICA_PRO' : 'JESSICA_START',
        });
      }
    });

    // Decorate Hotmart checkout links with captured UTMs
    if (Object.keys(activeUtms).length > 0) {
      document.querySelectorAll('a[href*="hotmart.com"]').forEach(function (a) {
        try {
          const url = new URL(a.href);
          Object.keys(activeUtms).forEach(function (k) {
            if (!url.searchParams.has(k)) {
              url.searchParams.set(k, activeUtms[k]);
            }
          });
          a.href = url.toString();
        } catch (err) {}
      });
    }

    // Initialize LGPD Banner
    initLgpdBanner();
  });

  // 6. LGPD Cookie Consent Banner
  function initLgpdBanner() {
    const consent = localStorage.getItem('raia_lgpd_consent');
    if (consent) {
      if (consent === 'all') loadThirdPartyPixels();
      return;
    }

    const banner = document.createElement('div');
    banner.id = 'raia-lgpd-banner';
    banner.innerHTML = `
      <div style="position: fixed; bottom: 16px; left: 16px; right: 16px; max-width: 680px; margin: 0 auto; background: rgba(17, 19, 26, 0.95); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 16px; padding: 18px 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); z-index: 999999; display: flex; flex-direction: column; gap: 14px; font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif; color: #E2E8F0;">
        <div style="display: flex; align-items: flex-start; gap: 14px;">
          <div style="font-size: 24px; line-height: 1;">🍪</div>
          <div style="font-size: 13.5px; line-height: 1.5; color: #94A3B8;">
            <strong style="color: #F8FAFC; font-weight: 600;">Sua privacidade é prioridade:</strong> Utilizamos cookies essenciais e tecnologias analíticas para aprimorar sua experiência e otimizar nosso atendimento, em total conformidade com a <strong>LGPD</strong>.
          </div>
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap;">
          <button id="raia-lgpd-reject" style="background: transparent; border: 1px solid rgba(255, 255, 255, 0.16); color: #94A3B8; padding: 8px 16px; border-radius: 9999px; font-size: 12.5px; font-weight: 600; cursor: pointer; transition: all 0.2s;">Apenas Necessários</button>
          <button id="raia-lgpd-accept" style="background: linear-gradient(135deg, #00F59B, #00D284); border: none; color: #07080C; padding: 8px 20px; border-radius: 9999px; font-size: 12.5px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 12px rgba(0, 245, 155, 0.3); transition: all 0.2s;">Aceitar Todos</button>
        </div>
      </div>
    `;

    document.body.appendChild(banner);

    document.getElementById('raia-lgpd-accept').addEventListener('click', function () {
      localStorage.setItem('raia_lgpd_consent', 'all');
      banner.remove();
      loadThirdPartyPixels();
    });

    document.getElementById('raia-lgpd-reject').addEventListener('click', function () {
      localStorage.setItem('raia_lgpd_consent', 'essential');
      banner.remove();
    });
  }

  // 7. Conditional Loading of GA4 & Meta Pixel
  function loadThirdPartyPixels() {
    // Google Analytics 4
    const ga4Id = window.RAIA_GA4_ID;
    if (ga4Id && !window.gtagLoaded) {
      window.gtagLoaded = true;
      const gaScript = document.createElement('script');
      gaScript.async = true;
      gaScript.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ga4Id);
      document.head.appendChild(gaScript);

      window.dataLayer = window.dataLayer || [];
      function gtag() { window.dataLayer.push(arguments); }
      window.gtag = gtag;
      gtag('js', new Date());
      gtag('config', ga4Id, { anonymize_ip: true });
    }

    // Meta Pixel
    const metaPixelId = window.RAIA_META_PIXEL_ID;
    if (metaPixelId && !window.fbqLoaded) {
      window.fbqLoaded = true;
      !(function (f, b, e, v, n, t, s) {
        if (f.fbq) return;
        n = f.fbq = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n;
        n.push = n; n.loaded = !0; n.version = '2.0';
        n.queue = []; t = b.createElement(e); t.async = !0;
        t.src = v; s = b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t, s);
      })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      window.fbq('init', metaPixelId);
      window.fbq('track', 'PageView');
    }
  }
})();
