(() => {
  const STORAGE_KEY = "discode-language";
  const DEFAULT_LANGUAGE = "en";

  const isLanguage = (value) => value === "en" || value === "ko";

  const getStoredLanguage = () => {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return isLanguage(value) ? value : null;
    } catch {
      return null;
    }
  };

  const setStoredLanguage = (language) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {}
  };

  const getDocsPathParts = (pathname) => {
    const match = pathname.match(/^(.*\/docs\/)(ko\/)?(.*)$/);
    if (!match) return null;
    return {
      prefix: match[1],
      isKorean: Boolean(match[2]),
      tail: match[3],
    };
  };

  const getPathLanguage = () => {
    const docsPath = getDocsPathParts(window.location.pathname);
    if (!docsPath) return null;
    return docsPath.isKorean ? "ko" : "en";
  };

  const getPathForLanguage = (language) => {
    const docsPath = getDocsPathParts(window.location.pathname);
    if (!docsPath) return window.location.pathname;
    if (language === "ko") {
      if (docsPath.isKorean) return window.location.pathname;
      return `${docsPath.prefix}ko/${docsPath.tail}`;
    }
    if (!docsPath.isKorean) return window.location.pathname;
    return `${docsPath.prefix}${docsPath.tail}`;
  };

  const updateDocsLinks = (language) => {
    const links = document.querySelectorAll("[data-docs-link]");
    links.forEach((link) => {
      const enHref = link.getAttribute("data-href-en");
      const koHref = link.getAttribute("data-href-ko");
      if (!enHref || !koHref) return;
      link.setAttribute("href", language === "ko" ? koHref : enHref);
    });
  };

  const redirectForLanguage = (language) => {
    const nextPath = getPathForLanguage(language);
    if (nextPath === window.location.pathname) return;
    window.location.replace(`${nextPath}${window.location.search}${window.location.hash}`);
  };

  const selects = Array.from(document.querySelectorAll("[data-language-select]"));
  const storedLanguage = getStoredLanguage();
  const pathLanguage = getPathLanguage();
  const activeLanguage = pathLanguage || storedLanguage || DEFAULT_LANGUAGE;

  selects.forEach((select) => {
    select.value = activeLanguage;
  });
  updateDocsLinks(activeLanguage);
  setStoredLanguage(activeLanguage);

  if (pathLanguage && storedLanguage && pathLanguage !== storedLanguage) {
    redirectForLanguage(storedLanguage);
    return;
  }

  selects.forEach((select) => {
    select.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      const nextLanguage = target.value;
      if (!isLanguage(nextLanguage)) return;
      setStoredLanguage(nextLanguage);
      selects.forEach((other) => {
        other.value = nextLanguage;
      });
      updateDocsLinks(nextLanguage);
      if (getPathLanguage()) {
        redirectForLanguage(nextLanguage);
      }
    });
  });
})();
