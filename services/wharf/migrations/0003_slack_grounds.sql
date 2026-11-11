-- A Slack link serves only these grounds; existing links have no implicit binding.
CREATE TABLE slackLinkGround (person text not null, grounds text not null, primary key (person, grounds));
-- OAuth pins the selected grounds to its single-use browser state.
CREATE TABLE slackConnectGround (state text not null, grounds text not null, primary key (state, grounds));
