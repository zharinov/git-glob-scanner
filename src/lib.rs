#![deny(clippy::all)]
#![allow(unused_imports)]

use napi_derive::napi;

use std::{collections::HashMap, path::Path, str::FromStr};

use globset::Glob;

#[napi]
pub fn plus_100(input: u32) -> u32 {
  input + 100
}

fn read_submodule_paths(gitmodules: &str) -> Result<Option<Vec<String>>, gix_config::parse::Error> {
  let file = gix_config::File::from_str(gitmodules)?;
  if let Some(sections) = file.sections_by_name("submodule") {
    let paths = sections
      .filter_map(|section| match section.value("path") {
        Some(path) => Some(path.to_string()),
        None => return None,
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

fn walk_repo<F, Res>(repo_dir: &str, f: F) -> Vec<Res>
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

  if let Some(glob) = submodule_glob {
    let prefix = repo_dir.to_string();
    walk_builder.filter_entry(move |entry| {
      let Some(file_type) = entry.file_type() else { return false; };
      if !file_type.is_dir() {
        return true;
      }
      let Ok(path) = entry.path().strip_prefix(&prefix) else { return false; };

      let Some(dir_name) = path.file_name() else { return false; };
      let Some(dir_name) = dir_name.to_str() else { return false; };
      if dir_name == ".git" {
        return false;
      }

      !glob.is_match(path)
    });
  } else {
    let prefix = repo_dir.to_string();
    walk_builder.filter_entry(move |entry| {
      let Some(file_type) = entry.file_type() else { return false; };
      if !file_type.is_dir() {
        return true;
      }
      let Ok(path) = entry.path().strip_prefix(&prefix) else { return false; };
      let Some(dir_name) = path.file_name() else { return false; };
      let Some(dir_name) = dir_name.to_str() else { return false; };
      dir_name == ".git"
    });
  }

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
      let Ok(entry) = entry else { return None; };
      let Ok(path) = entry.path().strip_prefix(repo_path) else { return None; };
      f(path)
    })
    .collect()
}

#[napi]
fn walk_repo_glob(repo_dir: String, glob: String) -> Option<Vec<String>> {
  let Ok(glob) = Glob::new(&glob) else { return None; };
  let matcher = glob.compile_matcher();
  let res = walk_repo(&repo_dir, |path| {
    if matcher.is_match(path) {
      let path = path.to_str()?;
      Some(path.to_string())
    } else {
      None
    }
  });
  Some(res)
}

#[test]
fn test_walk_repo_glob() {
  let repo = "../renovate".to_string();
  let glob = "**/package.json".to_string();
  let paths = walk_repo_glob(repo, glob).unwrap();
  for path in paths {
    println!("{}", path);
  }
}

#[napi]
fn walk_repo_globs(repo_dir: String, globs: Vec<String>) -> Option<Vec<String>> {
  let mut glob_builder = globset::GlobSetBuilder::new();
  for glob in globs {
    let Ok(glob) = Glob::new(&glob) else { continue; };
    glob_builder.add(glob);
  }
  let matcher = glob_builder.build().ok()?;
  let res = walk_repo(&repo_dir, |path| {
    if matcher.is_match(path) {
      let path = path.to_str()?;
      Some(path.to_string())
    } else {
      None
    }
  });
  Some(res)
}

#[test]
fn test_walk_repo_globs() {
  let repo = "../renovate".to_string();
  let globs = vec![
    "**/package.json".to_string(),
    "**/package-lock.json".to_string(),
  ];
  let paths = walk_repo_globs(repo, globs).unwrap();
  for path in paths {
    println!("{}", path);
  }
}

#[napi]
fn walk_repo_globs_map(
  repo_dir: String,
  globs_map: HashMap<String, Vec<String>>,
) -> Option<HashMap<String, Vec<String>>> {
  let matchers: Vec<(String, globset::GlobSet)> = globs_map
    .iter()
    .filter_map(|(key, globs)| {
      let mut glob_builder = globset::GlobSetBuilder::new();
      for glob in globs {
        let Ok(glob) = Glob::new(&glob) else { continue; };
        glob_builder.add(glob);
      }
      let Ok(matcher) = glob_builder.build() else { return None; };
      Some((key.clone(), matcher))
    })
    .collect();

  let result_pairs = walk_repo(&repo_dir, |path| {
    let path = path.to_str()?;
    for (key, matcher) in &matchers {
      if matcher.is_match(path) {
        return Some((key.to_string(), path.to_string()));
      }
    }
    None
  });

  let mut res = HashMap::new();
  for (key, path) in result_pairs {
    let paths = res.entry(key).or_insert_with(Vec::new);
    paths.push(path);
  }
  Some(res)
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
  let paths_map = walk_repo_globs_map(repo, globs_map).unwrap();
  for (key, paths) in paths_map {
    for path in paths {
      println!("{}: {}", key, path);
    }
  }
}
