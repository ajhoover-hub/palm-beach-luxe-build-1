import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { pushDataLayer } from "@/lib/gtm";
import { scrubSearch } from "@/lib/sensitiveUrl";

export const RouteTracker = () => {
  const { pathname, search } = useLocation();

  useEffect(() => {
    const pagePath = `${pathname}${scrubSearch(search)}`;
    // Defer one tick so react-helmet-async can update document.title first.
    const timer = window.setTimeout(() => {
      pushDataLayer({
        event: "virtual_pageview",
        page_path: pagePath,
        page_title: document.title,
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [pathname, search]);

  return null;
};
