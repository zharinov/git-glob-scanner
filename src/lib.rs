#![deny(clippy::all)]

use napi_derive::napi;

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;

use globset::Glob;

fn read_submodule_paths(gitmodules: &str) -> Result<Option<Vec<String>>, gix_config::parse::Error> {
  let file = gix_config::File::from_str(gitmodules)?;
  if let Some(sections) = file.sections_by_name("submodule") {
    let paths = sections
      .filter_map(|section| match section.value("path") {
        Some(path) => Some(path.to_string()),
        None => {
          return None;
        }
      })
      .collect::<Vec<String>>();
    return Ok(Some(paths));
  }
  return Ok(None);
}

#[test]
fn test_read_submodule_paths() {
  let gitmodules = r#"
    [submodule "foo/bar/baz"]
            path = foo/bar/baz
            url = https://github.com/zharinov/good-enough-parser
  "#;
  let paths = read_submodule_paths(gitmodules).unwrap();
  assert_eq!(paths, Some(vec!["foo/bar/baz".to_string()]));
}

fn get_submodule_paths(repo_path: &Path) -> Option<Vec<String>> {
  repo_path
    .join(".gitmodules")
    .to_str()
    .and_then(|gitmodules| std::fs::read_to_string(gitmodules).ok())
    .and_then(|gitmodules| read_submodule_paths(&gitmodules).ok())
    .unwrap_or(None)
}

fn walk_repo<'a, F, Res>(repo_dir: &str, f: F) -> Vec<Res>
where
  F: Fn(&Path) -> Option<Res>,
{
  let repo_path = Path::new(repo_dir);

  let submodule_paths = get_submodule_paths(repo_path);

  let submodule_glob = if let Some(paths) = submodule_paths {
    let mut glob_builder = globset::GlobSetBuilder::new();
    for path in paths {
      if let Ok(glob) = Glob::new(&path) {
        glob_builder.add(glob);
      }
    }
    glob_builder.build().ok()
  } else {
    None
  };

  let mut walk_builder = ignore::WalkBuilder::new(repo_path);
  walk_builder.follow_links(false);
  walk_builder.parents(false);
  walk_builder.hidden(false);
  walk_builder.git_exclude(false);

  let prefix = repo_dir.to_string();
  walk_builder.filter_entry(move |entry| {
    let Some(file_type) = entry.file_type() else {
      return false;
    };

    if file_type.is_file() {
      return true;
    }

    if file_type.is_symlink() {
      return false;
    }

    let Ok(path) = entry.path().strip_prefix(&prefix) else {
      return false;
    };

    let Some(dir_name) = path.file_name() else {
      return false;
    };

    let Some(dir_name) = dir_name.to_str() else {
      return false;
    };

    if dir_name == ".git" {
      return false;
    }

    if let Some(glob) = &submodule_glob {
      if glob.is_match(path) {
        return false;
      }
    }

    return true;
  });

  walk_builder.sort_by_file_path(|a, b| {
    if a.is_dir() && b.is_dir() {
      return a.cmp(b);
    }

    if !a.is_dir() && !b.is_dir() {
      return a.cmp(b);
    }

    if a.is_dir() {
      return std::cmp::Ordering::Greater;
    } else {
      return std::cmp::Ordering::Less;
    }
  });

  walk_builder
    .build()
    .filter_map(|entry| {
      let Ok(entry) = entry else {
        return None;
      };

      let path = entry.path();
      let Ok(path) = path.strip_prefix(repo_path) else {
        return None;
      };

      match path.to_str() {
        None => None,
        Some("") => None,
        Some(_) => f(path),
      }
    })
    .collect()
}

#[napi]
pub fn glob_to_regex(glob: String) -> Option<String> {
  let Ok(glob) = Glob::new(&glob) else {
    return None;
  };

  return Some(glob.regex().to_string());
}

#[napi]
pub fn walk_repo_glob(repo_dir: String, glob: String) -> Vec<String> {
  let Ok(glob) = Glob::new(&glob) else {
    return vec![];
  };

  let matcher = glob.compile_matcher();
  walk_repo(&repo_dir, |path| {
    if matcher.is_match(path) {
      let path = path.to_str()?;
      Some(path.to_string())
    } else {
      None
    }
  })
}

#[test]
pub fn test_walk_repo_glob() {
  let repo = ".".to_string();
  let glob = "*.json".to_string();
  let paths = walk_repo_glob(repo, glob);
  for path in paths {
    println!("{}", path);
  }
}

#[napi]
pub fn walk_repo_globs(repo_dir: String, globs: Vec<String>) -> Vec<String> {
  let mut glob_builder = globset::GlobSetBuilder::new();
  for glob in globs {
    let Ok(glob) = Glob::new(&glob) else {
      continue;
    };

    glob_builder.add(glob);
  }

  let Ok(matcher) = glob_builder.build() else {
    return vec![];
  };

  walk_repo(&repo_dir, |path| {
    if matcher.is_match(path) {
      let path = path.to_str()?;
      Some(path.to_string())
    } else {
      None
    }
  })
}

#[test]
fn test_walk_repo_globs() {
  let repo = "../renovate".to_string();
  let globs = vec![
    "**/package.json".to_string(),
    "**/package-lock.json".to_string(),
  ];
  let paths = walk_repo_globs(repo, globs);
  for path in paths {
    println!("{}", path);
  }
}

#[napi]
pub fn walk_repo_globs_map(
  repo_dir: String,
  globs_map: HashMap<String, Vec<String>>,
) -> HashMap<String, Vec<String>> {
  let mut accum: HashMap<&String, Vec<String>> = HashMap::new();
  let matchers: Vec<(&String, globset::GlobSet)> = globs_map
    .iter()
    .filter_map(|(key, globs)| {
      accum.insert(key, Vec::new());

      let mut glob_builder = globset::GlobSetBuilder::new();
      for glob in globs {
        let Ok(glob) = Glob::new(&glob) else {
          continue;
        };
        glob_builder.add(glob);
      }

      let Ok(matcher) = glob_builder.build() else {
        return None;
      };

      Some((key, matcher))
    })
    .collect();

  let pairs = walk_repo(&repo_dir, |path: &Path| {
    let mut matches: Vec<(&String, String)> = vec![];
    for (key, matcher) in &matchers {
      if matcher.is_match(path) {
        let key = *key;
        let val = path.to_str()?.to_string();
        matches.push((key, val));
      }
    }
    Some(matches)
  });

  for (key, path) in pairs.into_iter().flatten() {
    let entry = accum.entry(key);
    if let Entry::Occupied(entry) = entry {
      let paths = entry.into_mut();
      paths.push(path);
    }
  }

  let mut res: HashMap<String, Vec<String>> = HashMap::new();
  for (key, paths) in accum {
    res.insert(key.to_string(), paths);
  }

  return res;
}

#[test]
fn test_walk_repo_globs_map() {
  let repo = "../renovate".to_string();
  let mut globs_map = HashMap::new();
  globs_map.insert(
    "package".to_string(),
    vec![
      "**/package.json".to_string(),
      "**/package-lock.json".to_string(),
    ],
  );
  globs_map.insert(
    "lock".to_string(),
    vec![
      "**/yarn.lock".to_string(),
      "**/package-lock.json".to_string(),
    ],
  );
  let paths_map = walk_repo_globs_map(repo, globs_map);
  for (key, paths) in paths_map {
    for path in paths {
      println!("{}: {}", key, path);
    }
  }
}
