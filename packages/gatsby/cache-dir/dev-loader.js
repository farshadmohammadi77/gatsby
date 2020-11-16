import { BaseLoader, PageResourceStatus } from "./loader"
import { findPath } from "./find-path"
import ensureComponentInBundle from "./ensure-page-component-in-bundle"

import getSocket from "./socketIo"
import normalizePagePath from "./normalize-page-path"

// TODO move away from lodash
import isEqual from "lodash/isEqual"

function mergePageEntry(cachedPage, newPageData) {
  return {
    ...cachedPage,
    payload: {
      ...cachedPage.payload,
      json: newPageData.result,
      page: {
        ...cachedPage.payload.page,
        staticQueryResults: newPageData.staticQueryResults,
      },
    },
  }
}

class DevLoader extends BaseLoader {
  constructor(lazyRequires, matchPaths) {
    // One of the tests doesn't set a path.
    const loadComponent = chunkName => ensureComponentInBundle(chunkName)
    super(loadComponent, matchPaths)

    const socket = getSocket()

    this.notFoundPagePathsInCaches = new Set()

    if (socket) {
      socket.on(`message`, msg => {
        if (msg.type === `staticQueryResult`) {
          this.handleStaticQueryResultHotUpdate(msg)
        } else if (msg.type === `pageQueryResult`) {
          this.handlePageQueryResultHotUpdate(msg)
        }
      })
    } else {
      console.warn(`Could not get web socket`)
    }
  }

  loadPage(pagePath) {
    const realPath = findPath(pagePath)
    return super.loadPage(realPath).then(result => {
      if (this.isPageNotFound(realPath)) {
        this.notFoundPagePathsInCaches.add(realPath)
      }

      return result
    })
  }

  loadPageDataJson(rawPath) {
    return super.loadPageDataJson(rawPath).then(data => {
      // when we can't find a proper 404.html we fallback to dev-404-page
      // we need to make sure to mark it as not found.
      if (
        data.status === PageResourceStatus.Error &&
        rawPath !== `/dev-404-page/`
      ) {
        console.error(
          `404 page could not be found. Checkout https://www.gatsbyjs.org/docs/add-404-page/`
        )
        return this.loadPageDataJson(`/dev-404-page/`).then(result =>
          Object.assign({}, data, result)
        )
      }

      return data
    })
  }

  doPrefetch(pagePath) {
    return super.doPrefetch(pagePath).then(result => result.payload)
  }

  handleStaticQueryResultHotUpdate(msg) {
    const newResult = msg.payload.result

    const cacheKey = msg.payload.id
    const cachedResult = this.staticQueryDb[cacheKey]
    if (!isEqual(newResult, cachedResult)) {
      this.staticQueryDb[cacheKey] = newResult
      ___emitter.emit(`staticQueryResult`, newResult)
    }
  }

  handlePageQueryResultHotUpdate(msg) {
    const newPageData = msg.payload.result

    const pageDataDbCacheKey = normalizePagePath(msg.payload.id)
    const cachedPageData = this.pageDataDb.get(pageDataDbCacheKey)?.payload

    if (!isEqual(newPageData, cachedPageData)) {
      // always update canonical key for pageDataDb
      this.pageDataDb.set(pageDataDbCacheKey, {
        pagePath: pageDataDbCacheKey,
        payload: newPageData,
        status: `success`,
      })

      const cachedPage = this.pageDb.get(pageDataDbCacheKey)
      if (cachedPage) {
        this.pageDb.set(
          pageDataDbCacheKey,
          mergePageEntry(cachedPage, newPageData)
        )
      }

      // Additionally if those are query results for "/404.html"
      // we have to update all paths user wanted to visit, but didn't have
      // page for it, because we do store them under (normalized) path
      // user wanted to visit
      if (pageDataDbCacheKey === `/404.html`) {
        this.notFoundPagePathsInCaches.forEach(notFoundPath => {
          const previousPageDataEntry = this.pageDataDb.get(notFoundPath)
          if (previousPageDataEntry) {
            this.pageDataDb.set(notFoundPath, {
              ...previousPageDataEntry,
              payload: newPageData,
            })
          }

          const previousPageEntry = this.pageDb.get(notFoundPath)
          if (previousPageEntry) {
            this.pageDb.set(
              notFoundPath,
              mergePageEntry(previousPageEntry, newPageData)
            )
          }
        })
      }

      ___emitter.emit(`pageQueryResult`, newPageData)
    }
  }
}

export default DevLoader
